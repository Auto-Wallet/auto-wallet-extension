import React, { useEffect, useMemo, useRef, useState } from 'react';
import { callBackground } from '../popup/api';
import { ArrowDownIcon, ChevronDownIcon, ExternalLinkIcon, RefreshIcon } from '../popup/icons';
import {
  fetchAllQuotes,
  getProvider,
  isNativeAddress,
  loadSupportedSets,
  pickBestSlot,
  PROVIDERS,
  type MergedChain,
  type MergedToken,
  type NeutralQuote,
  type NeutralStatus,
  type ProviderId,
  type QuoteParams,
  type QuoteSlot,
} from '../lib/swap';
import { TokenPicker, type PickerSelection } from './TokenPicker';
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, toHex } from 'viem';
import type { Network } from '../types/network';

interface ActiveInfo {
  id: string;
  label: string;
  address: string;
  type: 'private' | 'ledger';
  derivationPath?: string;
}

interface Selection {
  chain: MergedChain;
  token: MergedToken;
}

type PickerSide = 'from' | 'to' | null;

type SwapStage =
  | { kind: 'idle' }
  | { kind: 'approving'; allowanceTx?: string }
  | { kind: 'swapping' }
  | { kind: 'submitted'; hash: string; providerId: ProviderId; requestId?: string }
  | { kind: 'error'; message: string };

// Default slippage matches typical swap UIs (1%).
const DEFAULT_SLIPPAGE = 0.01;
const SLIPPAGE_OPTIONS = [0.005, 0.01, 0.03];

// Max uint256 — used as the approve amount so the user only has to authorize
// the spender once per source token. Quote-derived spenders may differ
// slightly across requests, so an exact-amount approve would force a new
// approval per quote.
const MAX_UINT256 = (1n << 256n) - 1n;

export function SwapPage() {
  const [active, setActive] = useState<ActiveInfo | null>(null);
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [chains, setChains] = useState<MergedChain[]>([]);
  const [tokensByChain, setTokensByChain] = useState<Map<number, MergedToken[]>>(new Map());
  const [networks, setNetworks] = useState<Network[]>([]);

  const [from, setFrom] = useState<Selection | null>(null);
  const [to, setTo] = useState<Selection | null>(null);
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE);
  const [showSlippage, setShowSlippage] = useState(false);

  const [picker, setPicker] = useState<PickerSide>(null);

  const [quoteSlots, setQuoteSlots] = useState<QuoteSlot[]>(() => initialSlots());
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(null);
  // Whether the user has manually chosen a provider. While false, the
  // selection auto-tracks whichever provider quoted the higher amountOut.
  const userPickedProviderRef = useRef(false);

  const [balance, setBalance] = useState<string>(''); // human-formatted fromToken balance
  const [allowance, setAllowance] = useState<bigint | null>(null);

  const [stage, setStage] = useState<SwapStage>({ kind: 'idle' });
  // Live status polled from the selected provider after submission. `null`
  // means we're still waiting for the first poll to return.
  const [swapStatus, setSwapStatus] = useState<NeutralStatus | null>(null);
  const [statusPolling, setStatusPolling] = useState(false);
  // Bumped after a swap is submitted to force balance + quote re-fetch.
  // The previous quote's `amountOut` is stale once the source tx lands.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Per-swap cancellation token; used so a newly-started swap aborts the
  // polling loop from any previous one still in flight.
  const pollSeqRef = useRef(0);

  // Re-fetch quotes when inputs change.
  const reqIdRef = useRef(0);

  // Supported-chain set per provider, used to skip a provider when the
  // selected pair clearly isn't covered (avoids 400-noise from /quote).
  const supportedChainsByProvider = useMemo(() => {
    const map = new Map<ProviderId, Set<number>>();
    for (const p of PROVIDERS) map.set(p.id, new Set());
    for (const c of chains) {
      for (const id of c.providers) map.get(id)?.add(c.chainId);
    }
    return map;
  }, [chains]);

  useEffect(() => {
    (async () => {
      try {
        const [info, isUnlocked, nets] = await Promise.all([
          callBackground<ActiveInfo>('getActiveAccountInfo').catch(() => null),
          callBackground<boolean>('isUnlocked').catch(() => false),
          callBackground<Network[]>('getNetworks').catch(() => [] as Network[]),
        ]);
        setActive(info);
        setUnlocked(isUnlocked);
        setNetworks(nets);
      } catch {
        setUnlocked(false);
      }

      const sets = await loadSupportedSets();
      setChains(sets.chains);
      setTokensByChain(sets.tokensByChain);
    })();
  }, []);

  // Pre-seed from-token with the wallet's active network + native token, if
  // any provider supports it.
  useEffect(() => {
    if (from || chains.length === 0 || tokensByChain.size === 0) return;
    (async () => {
      try {
        const net = await callBackground<Network>('getActiveNetwork');
        const chain = chains.find((c) => c.chainId === net.chainId);
        const tokens = tokensByChain.get(net.chainId);
        if (!chain || !tokens) return;
        const native = tokens.find((t) => isNativeAddress(t.address));
        if (native) setFrom({ chain, token: native });
      } catch {
        // No active network or unsupported chain — leave selection empty.
      }
    })();
  }, [chains, tokensByChain, from]);

  // Load source-side balance whenever the from-token or wallet changes.
  useEffect(() => {
    if (!from || !active) { setBalance(''); setAllowance(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const info = await callBackground<{ balance: string; decimals: number }>('getBalanceForChain', {
          chainId: from.chain.chainId,
          tokenAddress: from.token.address,
          owner: active.address,
        });
        if (cancelled) return;
        setBalance(info.balance);
        setAllowance(null);
      } catch {
        if (!cancelled) { setBalance(''); setAllowance(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [from, active, refreshNonce]);

  // Fetch a quote from every provider in parallel whenever the inputs change.
  useEffect(() => {
    if (!from || !to || !active) {
      setQuoteSlots(initialSlots());
      return;
    }
    const amt = amount.trim();
    if (!amt || !/^\d+(\.\d+)?$/.test(amt) || parseFloat(amt) <= 0) {
      setQuoteSlots(initialSlots());
      return;
    }
    const id = ++reqIdRef.current;
    // Debounce 500ms after the last input change before hitting the provider
    // APIs. Keep the prior quote visible while the user is still typing —
    // flipping every card to "Fetching…" on each keystroke is more flicker
    // than feedback. The loading state only appears once the debounce fires.
    const timer = setTimeout(async () => {
      if (id !== reqIdRef.current) return; // superseded mid-debounce
      setQuoteSlots(loadingSlots());
      const params: QuoteParams = {
        fromChainId: from.chain.chainId,
        toChainId: to.chain.chainId,
        fromToken: from.token,
        toToken: to.token,
        fromAddress: active.address,
        toAddress: active.address,
        fromAmount: amt,
        slippage,
      };
      const slots = await fetchAllQuotes(params, supportedChainsByProvider);
      if (id !== reqIdRef.current) return;
      setQuoteSlots(slots);
      // Auto-select the higher amountOut quote unless the user already
      // manually picked. Compare via amountOutRaw (same to-token decimals).
      if (!userPickedProviderRef.current) {
        const best = pickBestSlot(slots);
        setSelectedProvider(best?.providerId ?? null);
      } else if (selectedProvider) {
        // If the user's previously-selected provider now has no quote, fall
        // back to the best available rather than disabling Swap silently.
        const stillOk = slots.find((s) => s.providerId === selectedProvider && s.quote);
        if (!stillOk) {
          userPickedProviderRef.current = false;
          setSelectedProvider(pickBestSlot(slots)?.providerId ?? null);
        }
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [from, to, amount, active, slippage, refreshNonce, supportedChainsByProvider]);

  const selectedQuote = useMemo<NeutralQuote | null>(() => {
    if (!selectedProvider) return null;
    return quoteSlots.find((s) => s.providerId === selectedProvider)?.quote ?? null;
  }, [quoteSlots, selectedProvider]);

  // Once we have a selected quote, refresh the allowance for its spender.
  useEffect(() => {
    if (!from || !active || !selectedQuote?.approvalSpender) { setAllowance(null); return; }
    if (isNativeAddress(from.token.address)) { setAllowance(0n); return; }
    let cancelled = false;
    (async () => {
      try {
        const raw = await callBackground<string>('getErc20Allowance', {
          chainId: from.chain.chainId,
          tokenAddress: from.token.address,
          owner: active.address,
          spender: selectedQuote.approvalSpender,
        });
        if (!cancelled) setAllowance(BigInt(raw));
      } catch {
        if (!cancelled) setAllowance(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedQuote?.approvalSpender, from, active]);

  const fromDecimals = useMemo(() => from ? from.token.decimals : 18, [from]);

  const amountRaw = useMemo<bigint | null>(() => {
    if (!from) return null;
    try { return parseUnits(amount.trim() || '0', fromDecimals); } catch { return null; }
  }, [amount, from, fromDecimals]);

  const needsApprove = useMemo(() => {
    if (!from) return false;
    if (isNativeAddress(from.token.address)) return false;
    if (!selectedQuote?.approvalSpender || amountRaw === null) return false;
    if (allowance === null) return false;
    return allowance < amountRaw;
  }, [from, selectedQuote?.approvalSpender, amountRaw, allowance]);

  const insufficientBalance = useMemo(() => {
    if (!balance || !amountRaw || !from) return false;
    try {
      const balRaw = parseUnits(balance, fromDecimals);
      return balRaw < amountRaw;
    } catch { return false; }
  }, [balance, amountRaw, fromDecimals, from]);

  const anyQuoteLoading = quoteSlots.some((s) => s.loading);

  function swapDirections() {
    if (!from || !to) return;
    setFrom(to);
    setTo(from);
  }

  function handlePick(side: PickerSide, sel: PickerSelection) {
    const chain = chains.find((c) => c.chainId === sel.chainId);
    if (!chain) return;
    const picked: Selection = { chain, token: sel.token };
    if (side === 'from') setFrom(picked);
    else if (side === 'to') setTo(picked);
    setPicker(null);
    // Picking a new pair invalidates the user's prior provider choice so we
    // re-pick whichever provider quotes higher on the new pair.
    userPickedProviderRef.current = false;
  }

  function handleProviderSelect(id: ProviderId) {
    userPickedProviderRef.current = true;
    setSelectedProvider(id);
  }

  async function performApprove() {
    if (!from || !active || !selectedQuote?.approvalSpender || !amountRaw) return;
    setStage({ kind: 'approving' });
    try {
      const tokenAddr = from.token.address as `0x${string}`;
      const spender = selectedQuote.approvalSpender as `0x${string}`;

      // USDT-style ERC20s require allowance to be reset to 0 before increasing
      // to a new non-zero value.
      if (allowance !== null && allowance > 0n) {
        const resetData = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, 0n],
        });
        await callBackground<string>('submitTxViaConfirm', {
          chainId: from.chain.chainId,
          origin: 'Auto Wallet Swap · Approve(0)',
          tx: { from: active.address, to: tokenAddr, data: resetData, value: '0x0' },
        });
      }

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, MAX_UINT256],
      });
      const approveHash = await callBackground<string>('submitTxViaConfirm', {
        chainId: from.chain.chainId,
        origin: 'Auto Wallet Swap · Approve',
        tx: { from: active.address, to: tokenAddr, data: approveData, value: '0x0' },
      });
      setStage({ kind: 'approving', allowanceTx: approveHash });
      // Pessimistic refresh — the receipt may not be mined yet but we want to
      // unblock the Swap button as soon as the user signs.
      setAllowance(MAX_UINT256);
    } catch (e: any) {
      setStage({ kind: 'error', message: e?.message ?? 'Approve rejected' });
    }
  }

  async function performSwap() {
    if (!from || !to || !active || !amountRaw || !selectedQuote || !selectedProvider) return;
    // Cancel any polling loop from a previous swap and clear its display.
    pollSeqRef.current += 1;
    setSwapStatus(null);
    setStatusPolling(false);
    setStage({ kind: 'swapping' });
    try {
      const params: QuoteParams = {
        fromChainId: from.chain.chainId,
        toChainId: to.chain.chainId,
        fromToken: from.token,
        toToken: to.token,
        fromAddress: active.address,
        toAddress: active.address,
        fromAmount: amount.trim(),
        slippage,
      };
      const provider = getProvider(selectedProvider);
      const prepared = await provider.prepareSwap(params, selectedQuote);
      const valueHex = (() => {
        const v = prepared.swapTx.value;
        if (!v || v === '0') return '0x0';
        if (v.startsWith('0x')) return v;
        try { return toHex(BigInt(v)); } catch { return '0x0'; }
      })();
      const hash = await callBackground<string>('submitTxViaConfirm', {
        chainId: prepared.swapTx.chainId,
        origin: `Auto Wallet Swap · ${provider.displayName}`,
        tx: {
          from: active.address,
          to: prepared.swapTx.to,
          data: prepared.swapTx.data ?? '0x',
          value: valueHex,
        },
      });
      setStage({ kind: 'submitted', hash, providerId: selectedProvider, requestId: prepared.requestId });
      setQuoteSlots(initialSlots());
      setRefreshNonce((n) => n + 1);
      setSwapStatus(null);
      pollSwapStatus(params, hash, selectedProvider, prepared.requestId);
    } catch (e: any) {
      setStage({ kind: 'error', message: e?.message ?? 'Swap failed' });
    }
  }

  /**
   * Poll the selected provider's status endpoint every 5s until a terminal
   * state is reached or we hit the cap (~10 min). Bumping `pollSeqRef.current`
   * cancels any earlier in-flight polling loop.
   */
  async function pollSwapStatus(
    params: QuoteParams,
    hash: string,
    providerId: ProviderId,
    requestId?: string,
  ) {
    const provider = getProvider(providerId);
    const mySeq = ++pollSeqRef.current;
    setStatusPolling(true);
    const MAX_ATTEMPTS = 120; // 5s × 120 = 10 min
    // Errors here are treated as transient: source tx may not be indexed yet,
    // the chain may be slow to mine, or the status endpoint may be having a
    // blip. Distinguishing terminal vs transient is the provider's job — it
    // owns the API semantics and turns known terminal failures (e.g. XFlows'
    // "Tx Failed") into NeutralStatus{state:'failed'} so they short-circuit
    // here as a non-pending state. Counting raw throws in this loop would
    // mis-fire on long indexer lags / 30s network blips and falsely fail
    // real pending swaps.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (mySeq !== pollSeqRef.current) return; // superseded by a newer swap
      try {
        const status = await provider.getStatus({ params, sourceHash: hash, requestId });
        if (mySeq !== pollSeqRef.current) return;
        setSwapStatus(status);
        if (status.state !== 'pending') {
          setStatusPolling(false);
          return;
        }
      } catch {
        // Silent retry — see comment above.
      }
      if (i < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (mySeq === pollSeqRef.current) setStatusPolling(false);
  }

  if (unlocked === false) {
    return (
      <div className="swap-shell">
        <div className="swap-locked">
          <p>The wallet is locked. Open the Auto Wallet popup, unlock it, and reload this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="swap-shell">
      <header className="swap-header">
        <div className="swap-header-left">
          <img src="icons/icon48.png" alt="" width={26} height={26} />
          <span className="swap-header-title">Cross-Chain Swap</span>
          <span className="swap-header-sub">XFlows · Relay</span>
        </div>
        <div className="swap-header-right">
          {active && (
            <span className="swap-header-addr">{active.label} · {shortAddr(active.address)}</span>
          )}
        </div>
      </header>

      <main className="swap-main">
        <div className="swap-card">
          <div className="swap-side">
            <div className="swap-side-label">From</div>
            <div className="swap-side-row">
              <input
                type="text"
                inputMode="decimal"
                className="swap-amount-input"
                placeholder="0.0"
                value={amount}
                onChange={(e) => {
                  // Strip non-numerics, then keep at most one decimal point so
                  // `parseUnits` never receives "1.2.3" and throws downstream.
                  const cleaned = e.target.value.replace(/[^0-9.]/g, '');
                  const firstDot = cleaned.indexOf('.');
                  const normalized = firstDot === -1
                    ? cleaned
                    : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
                  setAmount(normalized);
                }}
              />
              <button className="swap-token-pill" onClick={() => setPicker('from')} type="button">
                {from ? (
                  <>
                    <TokenAvatar token={from.token} />
                    <span className="swap-token-pill-text">
                      <span className="swap-token-symbol">{from.token.symbol}</span>
                      <span className="swap-token-chain">on {from.chain.name}</span>
                    </span>
                  </>
                ) : (
                  <span className="swap-token-placeholder">Select token</span>
                )}
                <ChevronDownIcon size={14} />
              </button>
            </div>
            {balance && from && (
              <div className="swap-side-meta">
                <span>Balance: {trimAmount(balance, 6)} {from.token.symbol}</span>
                <button
                  type="button"
                  className="swap-max-btn"
                  onClick={() => setAmount(balance)}
                >
                  MAX
                </button>
              </div>
            )}
          </div>

          <button type="button" className="swap-flip" aria-label="Flip direction" onClick={swapDirections}>
            <ArrowDownIcon size={16} />
          </button>

          <div className="swap-side">
            <div className="swap-side-label">To</div>
            <div className="swap-side-row">
              <div className="swap-amount-readonly">
                {anyQuoteLoading && !selectedQuote
                  ? <span className="swap-amount-placeholder">Fetching quotes…</span>
                  : selectedQuote
                    ? trimAmount(selectedQuote.amountOut, 8)
                    : <span className="swap-amount-placeholder">—</span>}
              </div>
              <button className="swap-token-pill" onClick={() => setPicker('to')} type="button">
                {to ? (
                  <>
                    <TokenAvatar token={to.token} />
                    <span className="swap-token-pill-text">
                      <span className="swap-token-symbol">{to.token.symbol}</span>
                      <span className="swap-token-chain">on {to.chain.name}</span>
                    </span>
                  </>
                ) : (
                  <span className="swap-token-placeholder">Select token</span>
                )}
                <ChevronDownIcon size={14} />
              </button>
            </div>
            {selectedQuote && to && (
              <div className="swap-side-meta swap-side-meta-muted">
                Min received: {trimAmount(selectedQuote.amountOutMin, 8)} {to.token.symbol}
              </div>
            )}
          </div>
        </div>

        {/* Per-provider quote cards */}
        {(amount && from && to) && (
          <QuoteList
            slots={quoteSlots}
            selectedProvider={selectedProvider}
            onSelect={handleProviderSelect}
            toSymbol={to?.token.symbol ?? ''}
          />
        )}

        {/* Action button */}
        <div className="swap-actions">
          {insufficientBalance ? (
            <button className="btn-primary swap-btn" disabled>Insufficient balance</button>
          ) : needsApprove ? (
            <button
              className="btn-primary swap-btn"
              onClick={performApprove}
              disabled={stage.kind === 'approving' || stage.kind === 'swapping'}
            >
              {stage.kind === 'approving' ? 'Approving…' : `Approve ${from?.token.symbol ?? ''}`}
            </button>
          ) : (
            <button
              className="btn-primary swap-btn"
              onClick={performSwap}
              disabled={
                !selectedQuote
                  || anyQuoteLoading
                  || stage.kind === 'swapping'
                  || !amountRaw
              }
            >
              {stage.kind === 'swapping'
                ? 'Submitting…'
                : selectedProvider
                  ? `Swap via ${displayNameOf(selectedProvider)}`
                  : 'Swap'}
            </button>
          )}
        </div>

        {/* Live stage feedback */}
        {stage.kind === 'submitted' && from && to && (
          <SwapStatusCard
            sourceHash={stage.hash}
            status={swapStatus}
            polling={statusPolling}
            sourceChainId={from.chain.chainId}
            destChainId={to.chain.chainId}
            destSymbol={to.token.symbol}
            providerName={displayNameOf(stage.providerId)}
            networks={networks}
          />
        )}
        {stage.kind === 'error' && (
          <div className="swap-status swap-status-error">
            {stage.message}
            <button
              type="button"
              className="btn-ghost"
              style={{ marginLeft: 8 }}
              onClick={() => setStage({ kind: 'idle' })}
            >
              <RefreshIcon size={12} /> Retry
            </button>
          </div>
        )}

        {/* Slippage + selected quote detail */}
        <div className="swap-summary">
          <div className="swap-summary-row">
            <span>Slippage</span>
            <div className="swap-slippage">
              {SLIPPAGE_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`swap-slippage-pill ${slippage === s ? 'is-active' : ''}`}
                  onClick={() => setSlippage(s)}
                >
                  {(s * 100).toFixed(s < 0.01 ? 1 : 0)}%
                </button>
              ))}
              <button
                type="button"
                className="swap-slippage-pill"
                onClick={() => setShowSlippage((v) => !v)}
              >
                ⋯
              </button>
            </div>
          </div>
          {showSlippage && (
            <div className="swap-summary-row">
              <span>Custom (%)</span>
              <input
                type="number"
                className="input-field swap-slippage-input"
                value={(slippage * 100).toString()}
                step={0.1}
                min={0.05}
                max={50}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v) && v > 0) setSlippage(v / 100);
                }}
              />
            </div>
          )}

          {selectedQuote && (
            <>
              {selectedQuote.routeDescription && (
                <div className="swap-summary-row">
                  <span>Route</span>
                  <span className="swap-summary-value">{selectedQuote.routeDescription}</span>
                </div>
              )}
              {selectedQuote.priceImpact !== undefined && (
                <div className="swap-summary-row">
                  <span>Price impact</span>
                  <span className={`swap-summary-value ${Math.abs(selectedQuote.priceImpact) > 5 ? 'is-warn' : ''}`}>
                    {selectedQuote.priceImpact.toFixed(2)}%
                  </span>
                </div>
              )}
              {/* ETA + fees are rendered per-quote-card above, so we don't
                  duplicate them in the summary. */}
            </>
          )}
        </div>
      </main>

      {picker && (
        <TokenPicker
          title={picker === 'from' ? 'Select source token' : 'Select destination token'}
          chains={chains}
          tokensByChain={tokensByChain}
          showBalances={picker === 'from'}
          ownerAddress={active?.address}
          onClose={() => setPicker(null)}
          onPick={(sel) => handlePick(picker, sel)}
        />
      )}
    </div>
  );
}

function initialSlots(): QuoteSlot[] {
  return PROVIDERS.map((p) => ({
    providerId: p.id,
    displayName: p.displayName,
    loading: false,
    quote: null,
    error: null,
    unsupported: false,
  }));
}

function loadingSlots(): QuoteSlot[] {
  return PROVIDERS.map((p) => ({
    providerId: p.id,
    displayName: p.displayName,
    loading: true,
    quote: null,
    error: null,
    unsupported: false,
  }));
}

function displayNameOf(id: ProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.displayName ?? id;
}

function QuoteList({
  slots, selectedProvider, onSelect, toSymbol,
}: {
  slots: QuoteSlot[];
  selectedProvider: ProviderId | null;
  onSelect: (id: ProviderId) => void;
  toSymbol: string;
}) {
  // "Best rate" by net amountOut across providers (same to-token decimals
  // means a direct raw-bigint comparison is safe). "Fastest" by ETA — only
  // counted when both providers report a time so the badge stays meaningful.
  const bestId = useMemo(() => pickBestSlot(slots)?.providerId ?? null, [slots]);
  const fastestId = useMemo(() => {
    const candidates = slots
      .map((s) => ({ id: s.providerId, eta: s.quote?.estimatedTimeSeconds }))
      .filter((x): x is { id: ProviderId; eta: number } => typeof x.eta === 'number' && isFinite(x.eta));
    if (candidates.length < 2) return null;
    candidates.sort((a, b) => a.eta - b.eta);
    const [first, second] = candidates;
    return first && second && first.eta < second.eta ? first.id : null;
  }, [slots]);

  return (
    <div className="swap-quotes">
      {slots.map((s) => {
        const isSelected = s.providerId === selectedProvider;
        const isBest = bestId === s.providerId;
        const isFastest = fastestId === s.providerId;
        return (
          <button
            key={s.providerId}
            type="button"
            className={`swap-quote ${isSelected ? 'is-selected' : ''} ${!s.quote ? 'is-empty' : ''}`}
            onClick={() => s.quote && onSelect(s.providerId)}
            disabled={!s.quote}
          >
            <div className="swap-quote-head">
              <span className="swap-quote-name">{s.displayName}</span>
              <div className="swap-quote-badges">
                {isBest && s.quote && <span className="swap-quote-badge is-best">Best value</span>}
                {isFastest && s.quote && <span className="swap-quote-badge is-fast">Fastest</span>}
              </div>
            </div>
            <div className="swap-quote-body">
              {s.loading ? (
                <span className="swap-quote-loading">Fetching…</span>
              ) : s.unsupported ? (
                <span className="swap-quote-unsupported">Pair not supported</span>
              ) : s.error ? (
                <span className="swap-quote-error" title={s.error}>{s.error}</span>
              ) : s.quote ? (
                <>
                  <span className="swap-quote-amount">{trimAmount(s.quote.amountOut, 8)}</span>
                  <span className="swap-quote-symbol">{toSymbol}</span>
                </>
              ) : (
                <span className="swap-quote-loading">—</span>
              )}
            </div>
            {s.quote && (s.quote.estimatedTimeSeconds !== undefined || s.quote.fees.length > 0) && (
              <div className="swap-quote-extras">
                {s.quote.estimatedTimeSeconds !== undefined && (
                  <div className="swap-quote-extra">
                    <span className="swap-quote-extra-label">ETA</span>
                    <span className="swap-quote-extra-value">{formatEta(s.quote.estimatedTimeSeconds)}</span>
                  </div>
                )}
                {s.quote.fees.map((f, idx) => (
                  <div key={`fee-${idx}`} className="swap-quote-extra">
                    <span className="swap-quote-extra-label">{f.label}</span>
                    <span className="swap-quote-extra-value">{f.amount} {f.symbol}</span>
                  </div>
                ))}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TokenAvatar({ token }: { token: MergedToken }) {
  const [failed, setFailed] = useState(false);
  if (failed || !token.logo) {
    const hue = token.symbol.split('').reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
    return (
      <span
        className="swap-token-fallback"
        style={{ background: `hsl(${hue}, 50%, 92%)`, color: `hsl(${hue}, 55%, 38%)` }}
      >
        {token.symbol.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={token.logo}
      alt={token.symbol}
      width={20}
      height={20}
      className="swap-token-logo"
      onError={() => setFailed(true)}
    />
  );
}

function formatEta(seconds: number): string {
  // Some providers (Relay) advertise `timeEstimate: 0` for fills that complete
  // within the same block as the source tx. Surface this as "Instant" instead
  // of swallowing it as "—" so the speed advantage is visible.
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds === 0) return 'Instant';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `~${m}m ${s}s` : `~${m}m`;
}

function trimAmount(s: string, maxDecimals: number): string {
  const num = parseFloat(s);
  if (!isFinite(num)) return s;
  if (num === 0) return '0';
  if (num >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const fixed = num.toFixed(maxDecimals);
  return fixed.replace(/\.?0+$/, '');
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// --- Status display ---

type StepState = 'done' | 'active' | 'pending' | 'failed';

interface StepDescriptor {
  label: string;
  state: StepState;
  hash?: string;
  chainId?: number;
  hint?: string;
}

interface StatusCardProps {
  sourceHash: string;
  status: NeutralStatus | null;
  polling: boolean;
  sourceChainId: number;
  destChainId: number;
  destSymbol: string;
  providerName: string;
  networks: Network[];
}

function SwapStatusCard({
  sourceHash, status, polling, sourceChainId, destChainId, destSymbol, providerName, networks,
}: StatusCardProps) {
  const sourceExplorer = networks.find((n) => n.chainId === sourceChainId)?.blockExplorerUrl;
  const destExplorer = networks.find((n) => n.chainId === destChainId)?.blockExplorerUrl;

  const state = status?.state;
  const terminal = state && state !== 'pending';
  const success = state === 'success';
  const refunded = state === 'refunded';
  const failed = state === 'failed';

  const steps: StepDescriptor[] = [
    {
      label: 'Source transaction submitted',
      state: 'done',
      hash: status?.sourceHash ?? sourceHash,
      chainId: sourceChainId,
    },
    {
      label: refunded
        ? 'Refunded'
        : failed
          ? 'Bridge failed'
          : terminal
            ? 'Bridge processed'
            : 'Bridging across chains',
      state: refunded || failed
        ? 'failed'
        : status?.destHash || success
          ? 'done'
          : 'active',
      hint: status?.hint,
    },
    {
      label: status?.destHash
        ? `Received on destination chain${status.receiveAmount ? ` · ${formatLooseAmount(status.receiveAmount)} ${destSymbol}` : ''}`
        : refunded
          ? 'No destination delivery'
          : failed
            ? 'Destination not reached'
            : 'Waiting for destination delivery',
      state: status?.destHash
        ? 'done'
        : refunded || failed
          ? 'failed'
          : success
            ? 'done'
            : 'pending',
      hash: status?.destHash,
      chainId: destChainId,
    },
  ];

  const banner = (() => {
    if (success) {
      return { kind: 'success' as const, text: `Swap complete${status?.receiveAmount ? ` — received ${formatLooseAmount(status.receiveAmount)} ${destSymbol}` : ''}` };
    }
    if (refunded) return { kind: 'warn' as const, text: 'Refunded — funds returned to your address' };
    if (failed) return { kind: 'error' as const, text: status?.message ?? 'Swap failed' };
    return { kind: 'info' as const, text: polling ? `Tracking swap status via ${providerName}…` : 'Status polling stopped' };
  })();

  return (
    <div className="swap-status-card">
      <div className={`swap-status-banner is-${banner.kind}`}>
        {polling && !terminal && <span className="swap-status-spinner" aria-hidden />}
        <span>{banner.text}</span>
      </div>

      <ol className="swap-steps">
        {steps.map((step, idx) => (
          <li key={idx} className={`swap-step is-${step.state}`}>
            <span className="swap-step-dot" />
            <div className="swap-step-body">
              <div className="swap-step-label">{step.label}</div>
              {step.hash && (
                <TxLink hash={step.hash} explorerUrl={
                  step.chainId === sourceChainId ? sourceExplorer : destExplorer
                } />
              )}
              {step.hint && <div className="swap-step-hint">{step.hint}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TxLink({ hash, explorerUrl }: { hash: string; explorerUrl?: string }) {
  const short = `${hash.slice(0, 12)}…${hash.slice(-8)}`;
  if (!explorerUrl) {
    return <span className="tx-link" style={{ cursor: 'default' }}>{short}</span>;
  }
  return (
    <a className="tx-link" href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noopener noreferrer">
      {short}
      <ExternalLinkIcon size={11} className="tx-link-icon" />
    </a>
  );
}

function formatLooseAmount(s: string): string {
  const n = parseFloat(s);
  if (!isFinite(n) || n === 0) return s;
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return n.toFixed(8).replace(/\.?0+$/, '');
}
