import React, { useEffect, useMemo, useState } from 'react';
import { MSG_SOURCE, genId } from '../types/messages';
import type { FeeSuggestions } from '../background/popup-handler';
import { callBackground } from './api';
import { parseNonceInput } from '../lib/nonce';

// User-edited values flow back as decimal-wei strings.
export interface FeeOverride {
  type: 'eip1559' | 'legacy';
  gas: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  gasPrice: string | null;
  /** Decimal nonce the user typed; null = let the wallet pick the next one. */
  nonce: string | null;
}

/** Which account/chain the nonce belongs to, and how it may be edited. */
export interface NonceOptions {
  address: string;
  chainId: number;
  /** Nonce fixed by the request (dApp-supplied, or a replacement's original). */
  prefill?: number;
  /** Speed-up / cancel must keep the original nonce: shown, not editable. */
  locked?: boolean;
}

export interface FeeEditorRequest {
  to?: string;
  from?: string;
  data?: string;
  value?: string;
}

const GWEI = 1_000_000_000n;
const ETHER = 1_000_000_000_000_000_000n;

export function hexToBigIntSafe(hex: string | undefined): bigint | null {
  if (!hex) return null;
  try { return BigInt(hex); } catch { return null; }
}

export function weiToGweiInput(wei: string | null): string {
  if (wei === null) return '';
  try {
    const n = BigInt(wei);
    const whole = n / GWEI;
    const remainder = n % GWEI;
    if (remainder === 0n) return whole.toString();
    const frac = remainder.toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch { return ''; }
}

export function gweiInputToWei(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const parts = s.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  const fracPadded = (frac + '000000000').slice(0, 9);
  try {
    const wei = BigInt(whole) * GWEI + BigInt(fracPadded);
    return wei.toString();
  } catch { return null; }
}

/**
 * Piecewise-log slider mapping for gas fees.
 *  - slider position 0   → 0.000001 gwei
 *  - slider position 500 → 1 gwei         (center)
 *  - slider position 1000 → 500 gwei
 * Each half is a uniform log10 ramp, so the user gets fine control near the
 * common values (sub-gwei priorities) without sacrificing reach for spikes.
 */
const SLIDER_MIN_GWEI = 0.000001;
const SLIDER_MID_GWEI = 1;
const SLIDER_MAX_GWEI = 500;
const SLIDER_STEPS = 1000;
const SLIDER_HALF = SLIDER_STEPS / 2;
const LOG_MIN = Math.log10(SLIDER_MIN_GWEI); // -6
const LOG_MID = Math.log10(SLIDER_MID_GWEI); //  0
const LOG_MAX = Math.log10(SLIDER_MAX_GWEI); // ≈ 2.699

export function sliderPosToGwei(pos: number): number {
  const clamped = Math.min(Math.max(pos, 0), SLIDER_STEPS);
  if (clamped <= SLIDER_HALF) {
    const t = clamped / SLIDER_HALF;
    return Math.pow(10, LOG_MIN + t * (LOG_MID - LOG_MIN));
  }
  const t = (clamped - SLIDER_HALF) / SLIDER_HALF;
  return Math.pow(10, LOG_MID + t * (LOG_MAX - LOG_MID));
}

export function gweiToSliderPos(gwei: number): number {
  if (!Number.isFinite(gwei) || gwei <= SLIDER_MIN_GWEI) return 0;
  if (gwei >= SLIDER_MAX_GWEI) return SLIDER_STEPS;
  const lg = Math.log10(gwei);
  if (gwei <= SLIDER_MID_GWEI) {
    const t = (lg - LOG_MIN) / (LOG_MID - LOG_MIN);
    return Math.round(t * SLIDER_HALF);
  }
  const t = (lg - LOG_MID) / (LOG_MAX - LOG_MID);
  return Math.round(SLIDER_HALF + t * SLIDER_HALF);
}

/** Format a gwei value with precision proportional to its magnitude. */
export function formatGweiForInput(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  let decimals: number;
  if (v >= 100)     decimals = 2;
  else if (v >= 10) decimals = 3;
  else if (v >= 1)  decimals = 4;
  else if (v >= 0.01)   decimals = 5;
  else if (v >= 0.0001) decimals = 7;
  else decimals = 9;
  // Trim trailing zeros, but keep at least one digit after the dot if there is one.
  return Number(v.toFixed(decimals)).toString();
}

function FeeInputWithSlider({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
}) {
  const parsed = parseFloat(value);
  const sliderPos = Number.isFinite(parsed) ? gweiToSliderPos(parsed) : 0;
  return (
    <div className="confirm-field">
      <span className="confirm-label">{label}</span>
      <div className="fee-input-row">
        <input
          className="input-field fee-input-text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder={placeholder}
        />
        <input
          className="fee-input-slider"
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={sliderPos}
          onChange={(e) => onChange(formatGweiForInput(sliderPosToGwei(parseFloat(e.target.value))))}
          aria-label={label}
          title="Log scale: midpoint = 1 gwei, ends = 0.000001 / 500 gwei"
        />
      </div>
    </div>
  );
}

export function formatEthFromWei(wei: bigint): string {
  if (wei === 0n) return '0';
  const whole = wei / ETHER;
  const remainder = wei % ETHER;
  if (remainder === 0n) return whole.toString();
  const fracStr = remainder.toString().padStart(18, '0').slice(0, 8).replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

interface FeeEditorProps {
  request: FeeEditorRequest;
  // Pre-fills from a tx (e.g. dApp-supplied values, hex strings)
  prefill?: {
    gas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    gasPrice?: string;
  };
  defaultOpen?: boolean;
  nonce?: NonceOptions;
  onChange: (override: FeeOverride | null) => void;
}

export function FeeEditor({ request, prefill, defaultOpen = false, nonce, onChange }: FeeEditorProps) {
  const [fees, setFees] = useState<FeeSuggestions | null>(null);
  const [feesError, setFeesError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(!defaultOpen);

  const [gasInput, setGasInput] = useState('');
  const [maxFeeInput, setMaxFeeInput] = useState('');
  const [priorityInput, setPriorityInput] = useState('');
  const [gasPriceInput, setGasPriceInput] = useState('');

  // Nonce: the chain's next (pending) nonce, and what the user typed.
  const [pendingNonce, setPendingNonce] = useState<number | null>(null);
  const [nonceInput, setNonceInput] = useState('');
  const [nonceLoadError, setNonceLoadError] = useState<string | null>(null);
  const nonceAddress = nonce?.address;
  const nonceChainId = nonce?.chainId;
  const noncePrefill = nonce?.prefill;

  useEffect(() => {
    if (!nonceAddress || nonceChainId === undefined) return;
    let cancelled = false;
    setNonceLoadError(null);
    callBackground<{ latest: number; pending: number }>('getNonceSuggestion', { address: nonceAddress, chainId: nonceChainId })
      .then((n) => {
        if (cancelled) return;
        setPendingNonce(n.pending);
        setNonceInput(String(noncePrefill ?? n.pending));
      })
      .catch((e: any) => {
        if (cancelled) return;
        setNonceLoadError(e?.message ?? 'Failed to load nonce');
        if (noncePrefill !== undefined) setNonceInput(String(noncePrefill));
      });
    return () => { cancelled = true; };
  }, [nonceAddress, nonceChainId, noncePrefill]);

  const nonceError = useMemo(() => {
    try { parseNonceInput(nonceInput); return null; } catch (e: any) { return e.message as string; }
  }, [nonceInput]);

  // Only send a nonce when it differs from what the wallet would pick anyway,
  // so an untouched form keeps the automatic next-nonce retry.
  const nonceOverride = useMemo<string | null>(() => {
    if (!nonce || nonce.locked) return null;
    const typed = nonceInput.trim();
    if (!typed) return null;
    if (nonce.prefill === undefined && pendingNonce !== null && typed === String(pendingNonce)) return null;
    return typed;
  }, [nonce, nonceInput, pendingNonce]);

  // Fetch suggestions whenever the request changes
  useEffect(() => {
    let cancelled = false;
    chrome.runtime.sendMessage(
      {
        source: MSG_SOURCE,
        id: genId(),
        type: 'popup_request',
        action: 'getFeeSuggestions',
        payload: {
          to: request.to,
          from: request.from,
          data: request.data,
          value: request.value,
        },
      },
      (response) => {
        if (cancelled) return;
        if (chrome.runtime.lastError) {
          setFeesError(chrome.runtime.lastError.message ?? 'Failed to fetch fees');
          return;
        }
        if (response?.error) {
          setFeesError(typeof response.error === 'string' ? response.error : response.error.message);
          return;
        }
        const f = response.result as FeeSuggestions;
        setFees(f);

        const pfGas = hexToBigIntSafe(prefill?.gas);
        const pfMax = hexToBigIntSafe(prefill?.maxFeePerGas);
        const pfPrio = hexToBigIntSafe(prefill?.maxPriorityFeePerGas);
        const pfPrice = hexToBigIntSafe(prefill?.gasPrice);

        setGasInput((pfGas ?? (f.gasEstimate ? BigInt(f.gasEstimate) : null))?.toString() ?? '');
        setMaxFeeInput(weiToGweiInput(pfMax?.toString() ?? f.maxFeePerGas));
        setPriorityInput(weiToGweiInput(pfPrio?.toString() ?? f.maxPriorityFeePerGas));
        setGasPriceInput(weiToGweiInput(pfPrice?.toString() ?? f.gasPrice));
      },
    );
    return () => { cancelled = true; };
    // We intentionally re-fetch only when request fields change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.to, request.from, request.data, request.value]);

  // Push override up whenever inputs change
  useEffect(() => {
    if (!fees) {
      onChange(null);
      return;
    }
    const gas = (() => { try { return gasInput ? BigInt(gasInput).toString() : null; } catch { return null; } })();
    if (fees.type === 'eip1559') {
      onChange({
        type: 'eip1559',
        gas,
        maxFeePerGas: gweiInputToWei(maxFeeInput),
        maxPriorityFeePerGas: gweiInputToWei(priorityInput),
        gasPrice: null,
        nonce: nonceOverride,
      });
    } else {
      onChange({
        type: 'legacy',
        gas,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        gasPrice: gweiInputToWei(gasPriceInput),
        nonce: nonceOverride,
      });
    }
  }, [fees, gasInput, maxFeeInput, priorityInput, gasPriceInput, nonceOverride]);

  const feePreview = useMemo(() => {
    if (!fees) return null;
    let gas: bigint;
    try { gas = gasInput ? BigInt(gasInput) : 0n; } catch { return null; }
    if (gas === 0n) return null;
    let priceWei: bigint | null = null;
    if (fees.type === 'eip1559') {
      const w = gweiInputToWei(maxFeeInput);
      if (w) priceWei = BigInt(w);
    } else {
      const w = gweiInputToWei(gasPriceInput);
      if (w) priceWei = BigInt(w);
    }
    if (priceWei === null) return null;
    return gas * priceWei;
  }, [fees, gasInput, maxFeeInput, gasPriceInput]);

  return (
    <div className="card" style={{ padding: 12 }}>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="row row-between"
        style={{
          width: '100%', padding: 0, background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span className="confirm-label" style={{ marginBottom: 0 }}>Network Fee</span>
        <span className="confirm-value mono" style={{ fontSize: 10 }}>
          {(() => {
            if (!fees) return 'loading...';
            if (feePreview !== null) {
              return `≈ ${formatEthFromWei(feePreview)} ${fees.symbol}`;
            }
            // No total yet — fall back to current gas price so the value isn't blank
            const priceWei = fees.type === 'eip1559' ? fees.maxFeePerGas : fees.gasPrice;
            if (priceWei) return `${weiToGweiInput(priceWei)} gwei`;
            return '—';
          })()}
          <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>{collapsed ? '▾' : '▴'}</span>
        </span>
      </button>

      {nonce && (
        <div className="row row-between" style={{ marginTop: 6 }}>
          <span className="confirm-label" style={{ marginBottom: 0 }}>Nonce</span>
          <span className="confirm-value mono" style={{ fontSize: 10 }}>
            {nonceInput || (nonceLoadError ? '—' : 'loading...')}
            {nonce.locked && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>(fixed)</span>}
            {!nonce.locked && nonceOverride !== null && <span style={{ marginLeft: 6, color: 'var(--warning)' }}>(custom)</span>}
          </span>
        </div>
      )}

      {!collapsed && (
        <div style={{ marginTop: 10 }}>
          {feesError && (
            <div className="confirm-warning" style={{ marginBottom: 8, fontSize: 10 }}>
              Failed to load suggestions: {feesError}. You can still set values manually.
            </div>
          )}

          {fees?.baseFeePerGas && (
            <div className="confirm-field">
              <span className="confirm-label">Base Fee</span>
              <span className="confirm-value mono" style={{ fontSize: 11 }}>
                {weiToGweiInput(fees.baseFeePerGas)} gwei
              </span>
            </div>
          )}

          <div className="confirm-field">
            <span className="confirm-label">Gas Limit (units)</span>
            <input
              className="input-field"
              inputMode="numeric"
              value={gasInput}
              onChange={(e) => setGasInput(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={fees?.gasEstimate ?? '21000'}
            />
          </div>

          {(!fees || fees.type === 'eip1559') && (
            <>
              <FeeInputWithSlider
                label="Max Fee Per Gas (gwei)"
                value={maxFeeInput}
                placeholder={fees?.maxFeePerGas ? weiToGweiInput(fees.maxFeePerGas) : '0'}
                onChange={setMaxFeeInput}
              />
              <FeeInputWithSlider
                label="Priority Fee (gwei)"
                value={priorityInput}
                placeholder={fees?.maxPriorityFeePerGas ? weiToGweiInput(fees.maxPriorityFeePerGas) : '0'}
                onChange={setPriorityInput}
              />
            </>
          )}

          {fees?.type === 'legacy' && (
            <FeeInputWithSlider
              label="Gas Price (gwei)"
              value={gasPriceInput}
              placeholder={fees?.gasPrice ? weiToGweiInput(fees.gasPrice) : '0'}
              onChange={setGasPriceInput}
            />
          )}

          {nonce && (
            <div className="confirm-field">
              <span className="confirm-label">Nonce</span>
              <input
                className="input-field"
                inputMode="numeric"
                value={nonceInput}
                disabled={nonce.locked}
                onChange={(e) => setNonceInput(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder={pendingNonce !== null ? String(pendingNonce) : 'auto'}
              />
              {nonce.locked ? (
                <p className="simulation-note">Replacements must reuse the original nonce.</p>
              ) : (
                <p className="simulation-note">
                  Next nonce: {pendingNonce ?? '…'}. A lower nonce replaces a pending tx; a higher one waits for the gap to fill.
                </p>
              )}
              {nonceLoadError && <p className="error-text">Couldn't load the next nonce: {nonceLoadError}</p>}
              {nonceError && <p className="error-text">{nonceError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
