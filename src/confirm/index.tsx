import '../lib/node-polyfills';
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MSG_SOURCE } from '../types/messages';
import { FeeEditor, type FeeOverride, type FeeEditorRequest } from '../popup/FeeEditor';
import { LedgerBadge } from '../popup/LedgerBadge';
import {
  signTransaction as ledgerSignTransaction,
  signPersonalMessage as ledgerSignPersonalMessage,
  signTypedDataHashed as ledgerSignTypedDataHashed,
} from '../lib/ledger';
import { buildSignedRawTx, hydrateTx, type SerializedTxJSON } from '../popup/ledger-signer';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  serializeTransaction,
  type TransactionSerializable,
} from 'viem';
import { callBackground } from '../popup/api';
import type { Network } from '../types/network';
import { findNetwork } from '../lib/network-manager.core';
import { STORAGE_KEYS } from '../lib/storage';
import { parseNonceInput } from '../lib/nonce';
import { TRUST_DURATIONS_MS } from '../lib/whitelist.core';
import '../popup/styles.css';

/** Requests "Trust this site" can apply to (mirrors confirm-manager). */
const TRUSTABLE_METHODS = new Set(['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4']);
const DEFAULT_TRUST_MS = 60 * 60 * 1000;

function trustDurationLabel(ms: number): string {
  const minutes = ms / 60_000;
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
}

type ConfirmAck = { ok: true } | { ok: false; error: string } | undefined;

/** Send the popup's answer; resolves with the background's acknowledgement. */
function sendConfirmResponse(message: Record<string, unknown>): Promise<ConfirmAck> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ source: MSG_SOURCE, type: 'confirm_response', ...message }, (ack: ConfirmAck) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'unreachable' });
        return;
      }
      resolve(ack);
    });
  });
}

const EXPIRED_MESSAGE = 'This request has expired (the wallet restarted or locked). Close this window and try again from the site.';

interface LedgerCtx {
  derivationPath: string;
  txJson?: SerializedTxJSON;
  messageHex?: string;
  domainSeparator?: `0x${string}`;
  hashStructMessage?: `0x${string}`;
}

type SimulatedTokenChange = {
  key: string;
  symbol: string;
  name?: string;
  address?: string;
  rawDelta: string;
  formattedDelta: string;
  direction: 'in' | 'out';
};

type SimulationPreview = {
  status: 'success' | 'failed' | 'unavailable';
  error?: string;
  gasUsed?: string;
  changes: SimulatedTokenChange[];
};

type ApprovalDetails = {
  tokenAddress: `0x${string}`;
  spender: `0x${string}`;
  amountRaw: bigint;
};

type ApprovalTokenInfo = {
  symbol: string;
  decimals: number;
  name?: string;
  balanceRaw: string;
  balance: string;
};

interface PendingRequest {
  id: string;
  method: string;
  origin: string;
  params: any;
  signerAddress?: string;
  chainId?: number;
  chainName?: string;
  nativeSymbol?: string;
  ledger?: LedgerCtx;
  simulation?: SimulationPreview;
  simulationPending?: boolean;
  lockNonce?: boolean;
}

function prettyTypedData(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function shortAddress(value?: string): string {
  if (!value) return '';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/**
 * BCS API returns `gas_used` as a string that may be hex (`0x5208`) or
 * decimal (`21000`). Normalize to a decimal display so it's readable.
 */
function formatGasUsed(value: string): string {
  const raw = value.trim();
  try {
    const n = raw.startsWith('0x') || raw.startsWith('0X')
      ? BigInt(raw)
      : BigInt(raw);
    return n.toLocaleString('en-US');
  } catch {
    return raw;
  }
}

function resolveStoredChainInfo(
  chainId: number,
  callback: (info: { name?: string; symbol?: string }) => void,
): void {
  chrome.storage.local.get(STORAGE_KEYS.NETWORKS, (result) => {
    const stored = (result[STORAGE_KEYS.NETWORKS] as Network[] | undefined) ?? [];
    const network = findNetwork(stored, chainId);
    callback({ name: network?.name, symbol: network?.symbol });
  });
}

function parseApprovalDetails(tx: any): ApprovalDetails | null {
  if (!tx?.to || !tx?.data) return null;
  try {
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: tx.data as `0x${string}`,
    });
    if (decoded.functionName !== 'approve') return null;
    const [spender, amount] = decoded.args as [`0x${string}`, bigint];
    return {
      tokenAddress: tx.to as `0x${string}`,
      spender,
      amountRaw: amount,
    };
  } catch {
    return null;
  }
}

function SimulationSkeleton() {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="confirm-row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span className="confirm-label" style={{ marginBottom: 0 }}>Simulated Token Changes</span>
        <span className="simulation-pill pending">Simulating…</span>
      </div>
      <div className="simulation-skeleton">
        <div className="simulation-skeleton-row" />
        <div className="simulation-skeleton-row" />
      </div>
    </div>
  );
}

function SimulationChanges({
  simulation,
  pending,
}: {
  simulation?: SimulationPreview;
  pending?: boolean;
}) {
  if (!simulation) {
    if (pending) return <SimulationSkeleton />;
    return null;
  }

  if (simulation.status === 'unavailable') {
    return (
      <div className="card" style={{ padding: 12 }}>
        <div className="confirm-row" style={{ alignItems: 'center' }}>
          <span className="confirm-label" style={{ marginBottom: 0 }}>Simulation</span>
          <span className="simulation-pill unavailable">Unavailable</span>
        </div>
        {simulation.error && (
          <p className="simulation-note">{simulation.error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="confirm-row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span className="confirm-label" style={{ marginBottom: 0 }}>Simulated Token Changes</span>
        <span className={`simulation-pill ${simulation.status}`}>
          {simulation.status === 'success' ? 'Success' : 'Failed'}
        </span>
      </div>
      {simulation.error && (
        <p className="simulation-note">{simulation.error}</p>
      )}
      {simulation.changes.length > 0 ? (
        <div className="simulation-list">
          {simulation.changes.map((change) => (
            <div key={change.key} className="simulation-change-row">
              <div className="simulation-token">
                <span className={`simulation-token-dot ${change.direction}`} />
                <div>
                  <span className="simulation-token-symbol">{change.symbol}</span>
                  {change.address && (
                    <span className="simulation-token-address mono">{shortAddress(change.address)}</span>
                  )}
                </div>
              </div>
              <span className={`simulation-delta ${change.direction}`}>
                {change.formattedDelta}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="simulation-note">No token balance changes detected.</p>
      )}
      {simulation.gasUsed && (
        <p className="simulation-note">Estimated gas used: {formatGasUsed(simulation.gasUsed)}</p>
      )}
    </div>
  );
}

function ConfirmPage() {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  // null = "Trust this site" off; otherwise how long auto-sign stays on.
  const [trustDurationMs, setTrustDurationMs] = useState<number | null>(null);
  const [feeOverride, setFeeOverride] = useState<FeeOverride | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState('');
  const [error, setError] = useState('');
  const [approvalInfo, setApprovalInfo] = useState<ApprovalTokenInfo | null>(null);
  const [approvalAmount, setApprovalAmount] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [showJson, setShowJson] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestId = params.get('id');
    if (!requestId) return;

    const requestKey = `confirm_${requestId}`;
    const simulationKey = `confirm_${requestId}_simulation`;

    // Initial read — request + any already-resolved simulation
    chrome.storage.session.get([requestKey, simulationKey], (result) => {
      const stored = result[requestKey] as PendingRequest | undefined;
      if (!stored) return;
      const earlySim = result[simulationKey] as SimulationPreview | undefined;
      const initial: PendingRequest = earlySim
        ? { ...stored, simulation: earlySim, simulationPending: false }
        : stored;
      setRequest(initial);
      if (initial.chainId && (!initial.chainName || !initial.nativeSymbol)) {
        resolveStoredChainInfo(initial.chainId, ({ name, symbol }) => {
          setRequest((current) => {
            if (!current) return current;
            const next = { ...current };
            if (!next.chainName && name) next.chainName = name;
            if (!next.nativeSymbol && symbol) next.nativeSymbol = symbol;
            return next;
          });
        });
      }
    });

    // Listen for simulation result arriving after the popup is open
    const onStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'session') return;
      const change = changes[simulationKey];
      if (!change) return;
      const simulation = change.newValue as SimulationPreview | undefined;
      if (!simulation) return;
      setRequest((current) =>
        current ? { ...current, simulation, simulationPending: false } : current,
      );
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, []);

  useEffect(() => {
    if (!request || request.method !== 'eth_sendTransaction') return;
    const details = parseApprovalDetails(request.params?.[0]);
    if (!details || !request.signerAddress || !request.chainId) {
      setApprovalInfo(null);
      setApprovalAmount('');
      setApprovalError('');
      return;
    }

    let cancelled = false;
    callBackground<ApprovalTokenInfo>('getApprovalTokenInfo', {
      chainId: request.chainId,
      tokenAddress: details.tokenAddress,
      owner: request.signerAddress,
    }).then((info) => {
      if (cancelled) return;
      setApprovalInfo(info);
      setApprovalAmount(formatUnits(details.amountRaw, info.decimals));
      setApprovalError('');
    }).catch((e: any) => {
      if (!cancelled) setApprovalError(e?.message ?? 'Failed to load token balance');
    });

    return () => { cancelled = true; };
  }, [request]);

  function buildApprovalDataOverride(): `0x${string}` | null {
    if (!request) return null;
    const details = parseApprovalDetails(request.params?.[0]);
    if (!details) return null;
    if (!approvalInfo) throw new Error('Token balance is still loading');
    const trimmed = approvalAmount.trim();
    if (!trimmed) throw new Error('Approve amount is required');
    const amount = parseUnits(trimmed, approvalInfo.decimals);
    return encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [details.spender, amount],
    });
  }

  function applyFeeToTxJson(json: SerializedTxJSON, fee: FeeOverride | null): SerializedTxJSON {
    if (!fee) return json;
    const next: SerializedTxJSON = { ...json };
    if (fee.gas) next.gas = fee.gas;
    const nonce = parseNonceInput(fee.nonce);
    if (nonce !== null) next.nonce = nonce;
    if (fee.type === 'eip1559') {
      next.type = 'eip1559';
      if (fee.maxFeePerGas) next.maxFeePerGas = fee.maxFeePerGas;
      if (fee.maxPriorityFeePerGas) next.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
      next.gasPrice = undefined;
    } else if (fee.type === 'legacy') {
      next.type = 'legacy';
      if (fee.gasPrice) next.gasPrice = fee.gasPrice;
      next.maxFeePerGas = undefined;
      next.maxPriorityFeePerGas = undefined;
    }
    return next;
  }

  /** Close on success; keep the window open with an explanation if the request is gone. */
  function finish(ack: ConfirmAck) {
    if (ack && !ack.ok) {
      setError(EXPIRED_MESSAGE);
      setBusy(false);
      setBusyMsg('');
      return;
    }
    window.close();
  }

  async function approve() {
    setError('');
    const ledger = request?.ledger;
    if (request?.method === 'eth_sendTransaction') {
      try {
        parseNonceInput(feeOverride?.nonce);
      } catch (e: any) {
        setError(e.message);
        return;
      }
    }
    if (!ledger) {
      let txDataOverride: `0x${string}` | null = null;
      try {
        txDataOverride = buildApprovalDataOverride();
      } catch (e: any) {
        setApprovalError(e?.message ?? 'Invalid approve amount');
        return;
      }
      // Software signing happens server-side
      setBusy(true);
      const ack = await sendConfirmResponse({
        requestId: request?.id,
        approved: true,
        trustDurationMs: request && TRUSTABLE_METHODS.has(request.method) ? trustDurationMs : null,
        feeOverride: request?.method === 'eth_sendTransaction' ? feeOverride : null,
        txDataOverride,
      });
      finish(ack);
      return;
    }

    // Ledger signing in this window
    try {
      setBusy(true);
      let signedRawTx: `0x${string}` | null = null;
      let signature: `0x${string}` | null = null;

      if (request!.method === 'eth_sendTransaction' && ledger.txJson) {
        setBusyMsg('Confirm on your Ledger device…');
        const txDataOverride = buildApprovalDataOverride();
        const finalTx = applyFeeToTxJson({
          ...ledger.txJson,
          data: txDataOverride ?? ledger.txJson.data,
        }, feeOverride);
        // Re-serialize unsigned hex with the (potentially edited) fee values
        const unsignedHex = serializeTransaction(hydrateTx(finalTx) as TransactionSerializable)
          .replace(/^0x/, '');
        const sig = await ledgerSignTransaction(ledger.derivationPath, unsignedHex);
        signedRawTx = buildSignedRawTx(finalTx, sig);
      } else if ((request!.method === 'personal_sign' || request!.method === 'eth_sign') && ledger.messageHex) {
        setBusyMsg('Confirm on your Ledger device…');
        signature = await ledgerSignPersonalMessage(ledger.derivationPath, ledger.messageHex);
      } else if (
        (request!.method === 'eth_signTypedData_v4' || request!.method === 'eth_signTypedData') &&
        ledger.domainSeparator && ledger.hashStructMessage
      ) {
        setBusyMsg('Confirm on your Ledger device (blind sign typed data)…');
        signature = await ledgerSignTypedDataHashed(
          ledger.derivationPath, ledger.domainSeparator, ledger.hashStructMessage,
        );
      } else {
        throw new Error('Ledger context is missing required fields for this method');
      }

      const ack = await sendConfirmResponse({
        requestId: request!.id,
        approved: true,
        trustDurationMs: null,    // ledger always requires the device; auto-sign can't apply
        txDataOverride: buildApprovalDataOverride(),
        signedRawTx,
        signature,
      });
      finish(ack);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setBusy(false);
      setBusyMsg('');
    }
  }

  async function reject() {
    // Close either way: an expired request has nothing left to reject.
    await sendConfirmResponse({ requestId: request?.id, approved: false });
    window.close();
  }

  if (!request) {
    return (
      <div className="confirm-shell">
        <div className="loading-page"><div className="spinner" /></div>
      </div>
    );
  }

  const tx = request.params?.[0] ?? {};
  const isLedger = !!request.ledger;
  const isTransaction = request.method === 'eth_sendTransaction';
  const isPersonalSign = request.method === 'personal_sign' || request.method === 'eth_sign';
  const isTypedData = request.method === 'eth_signTypedData_v4' || request.method === 'eth_signTypedData';
  const isAddChain = request.method === 'wallet_addEthereumChain';
  const isConnect = request.method === 'eth_requestAccounts';
  const isWatchAsset = request.method === 'wallet_watchAsset';
  const canTrust = !isLedger && TRUSTABLE_METHODS.has(request.method);
  const watchAsset = isWatchAsset ? request.params?.[0] as {
    address: string; symbol: string; decimals: number; name?: string;
    requestedSymbol?: string; requestedDecimals?: number;
  } : null;
  const title = isConnect ? 'Connect Site' : isWatchAsset ? 'Add Token' : 'Confirm Request';
  const approveLabel = isConnect ? 'Connect' : isWatchAsset ? 'Add Token' : 'Approve';
  const txNonce = isTransaction && typeof tx.nonce === 'string' ? Number(BigInt(tx.nonce)) : undefined;

  const value = tx.value ? (parseInt(tx.value, 16) / 1e18).toFixed(6) : '0';
  const nativeSymbol = request.nativeSymbol ?? 'ETH';
  const to = tx.to ?? 'Contract creation';
  const calldata = tx.data;
  const methodSig = calldata?.slice(0, 10) ?? '-';
  const approvalDetails = isTransaction ? parseApprovalDetails(tx) : null;
  const requestedApprovalAmount = approvalDetails && approvalInfo
    ? formatUnits(approvalDetails.amountRaw, approvalInfo.decimals)
    : '';
  let approvalDataForFee: `0x${string}` | undefined;
  if (approvalDetails && approvalInfo && approvalAmount.trim()) {
    try {
      approvalDataForFee = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [approvalDetails.spender, parseUnits(approvalAmount.trim(), approvalInfo.decimals)],
      });
    } catch {}
  }

  // Extract domain from origin
  let domain = request.origin;
  try { domain = new URL(request.origin).hostname; } catch {}

  const feeRequest: FeeEditorRequest | null = isTransaction
    ? { to: tx.to, from: tx.from, data: approvalDataForFee ?? tx.data, value: tx.value }
    : null;

  // For Ledger sends, prefill FeeEditor from the prepared tx (which already has resolved fees).
  const ledgerTxJson = request.ledger?.txJson;
  const feePrefill = isTransaction
    ? (ledgerTxJson
        ? {
            gas: ledgerTxJson.gas ? `0x${BigInt(ledgerTxJson.gas).toString(16)}` : undefined,
            maxFeePerGas: ledgerTxJson.maxFeePerGas ? `0x${BigInt(ledgerTxJson.maxFeePerGas).toString(16)}` : undefined,
            maxPriorityFeePerGas: ledgerTxJson.maxPriorityFeePerGas ? `0x${BigInt(ledgerTxJson.maxPriorityFeePerGas).toString(16)}` : undefined,
            gasPrice: ledgerTxJson.gasPrice ? `0x${BigInt(ledgerTxJson.gasPrice).toString(16)}` : undefined,
          }
        : {
            gas: tx.gas ?? tx.gasLimit,
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
            gasPrice: tx.gasPrice,
          })
    : undefined;

  return (
    <div className="confirm-shell">
      {/* Header */}
      <header className="confirm-header">
        <img src="icons/icon48.png" alt="" style={{ width: 24, height: 24 }} />
        <span className="confirm-header-title">
          {isLedger && <LedgerBadge title="Ledger hardware wallet" />}
          {title}
        </span>
      </header>

      {/* Body */}
      <main className="confirm-body">
        {/* Origin */}
        <div className="confirm-origin">
          <span className="confirm-origin-dot" />
          <span className="confirm-origin-text">{domain}</span>
          <span className="confirm-origin-secure">Secure connection</span>
        </div>

        {/* Signer info */}
        {(request.signerAddress || request.chainId) && (
          <div className="card" style={{ padding: '8px 12px' }}>
            <div className="confirm-row">
              {request.signerAddress && (
                <div className="confirm-field" style={{ marginBottom: 0 }}>
                  <span className="confirm-label">Signer</span>
                  <span className="confirm-value mono" style={{ fontSize: 10 }}>
                    {isLedger && <LedgerBadge title="Ledger hardware wallet" />}
                    {request.signerAddress.slice(0, 8)}...{request.signerAddress.slice(-6)}
                  </span>
                </div>
              )}
              {request.chainId && (
                <div className="confirm-field" style={{ marginBottom: 0, textAlign: 'right' }}>
                  <span className="confirm-label">Chain</span>
                  <div className="confirm-chain">
                    <span className="confirm-chain-name">{request.chainName ?? `Chain ${request.chainId}`}</span>
                    <span className="chain-id-pill">#{request.chainId}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Method badge + JSON inspector trigger */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 4 }}>
          <span className="badge" style={{
            background: 'var(--accent-subtle)', color: 'var(--accent)',
            border: '1px solid rgba(79,70,229,.15)', fontSize: 11, padding: '4px 12px',
          }}>
            {request.method}
          </span>
          <button
            type="button"
            onClick={() => { setShowJson(true); setJsonCopied(false); }}
            className="json-inspector-btn"
            title="Show full request as JSON (copy for AI analysis)"
          >
            {'{ }'} JSON
          </button>
        </div>

        {/* Transaction details */}
        {isTransaction && (
          <div className="card">
            <div className="confirm-row" style={{ alignItems: 'flex-start' }}>
              <div className="confirm-field" style={{ flex: 1, minWidth: 0 }}>
                <span className="confirm-label">Value</span>
                <span className="confirm-value-big">{value} {nativeSymbol}</span>
              </div>
              <div className="confirm-field" style={{ textAlign: 'right', flexShrink: 0 }}>
                <span className="confirm-label">Method</span>
                <span className="confirm-value mono">{methodSig}</span>
              </div>
            </div>
            <div className="confirm-field" style={{ marginTop: 14 }}>
              <span className="confirm-label">To</span>
              <span className="confirm-value mono truncate">{to}</span>
            </div>
            {approvalDetails && (
              <div className="approval-editor">
                <div className="confirm-row" style={{ alignItems: 'center', marginBottom: 8 }}>
                  <span className="confirm-label" style={{ marginBottom: 0 }}>ERC-20 Approve</span>
                  <span className="approval-pill">Editable</span>
                </div>
                <div className="confirm-field">
                  <span className="confirm-label">Token</span>
                  <span className="confirm-value mono truncate">{approvalInfo?.symbol ?? to}</span>
                </div>
                <div className="confirm-field">
                  <span className="confirm-label">Spender</span>
                  <span className="confirm-value mono truncate">{approvalDetails.spender}</span>
                </div>
                <div className="confirm-field">
                  <span className="confirm-label">Approve Amount</span>
                  <div className="approval-input-row">
                    <input
                      className="input-field approval-input"
                      value={approvalAmount}
                      onChange={(e) => {
                        setApprovalAmount(e.target.value);
                        setApprovalError('');
                      }}
                      inputMode="decimal"
                      placeholder={approvalInfo ? `Amount (${approvalInfo.symbol})` : 'Loading token...'}
                      disabled={!approvalInfo}
                    />
                  </div>
                </div>
                <div className="approval-reference-row">
                  <span className="approval-balance">
                    Balance: {approvalInfo ? `${approvalInfo.balance} ${approvalInfo.symbol}` : 'Loading...'}
                  </span>
                  <button
                    type="button"
                    className="approval-link-btn"
                    disabled={!approvalInfo}
                    onClick={() => {
                      if (!approvalInfo) return;
                      setApprovalAmount(approvalInfo.balance);
                      setApprovalError('');
                    }}
                  >
                    Use Balance
                  </button>
                </div>
                <div className="approval-reference-row">
                  <span className="approval-balance">
                    Requested: {approvalInfo ? `${requestedApprovalAmount} ${approvalInfo.symbol}` : 'Loading...'}
                  </span>
                  <button
                    type="button"
                    className="approval-link-btn"
                    disabled={!approvalInfo}
                    onClick={() => {
                      if (!approvalInfo) return;
                      setApprovalAmount(requestedApprovalAmount);
                      setApprovalError('');
                    }}
                  >
                    Use Requested
                  </button>
                </div>
                {approvalError && <p className="error-text">{approvalError}</p>}
              </div>
            )}
            {calldata && calldata.length > 10 && (
              <div className="confirm-field">
                <span className="confirm-label">Data</span>
                <div className="confirm-data mono">{calldata}</div>
              </div>
            )}
          </div>
        )}

        {isTransaction && (
          <SimulationChanges
            simulation={request.simulation}
            pending={request.simulationPending}
          />
        )}

        {/* Fee editor */}
        {feeRequest && (
          <FeeEditor
            request={feeRequest}
            prefill={feePrefill}
            nonce={request.signerAddress && request.chainId
              ? {
                  address: request.signerAddress,
                  chainId: request.chainId,
                  prefill: ledgerTxJson?.nonce ?? txNonce,
                  locked: request.lockNonce,
                }
              : undefined}
            onChange={setFeeOverride}
          />
        )}

        {/* Personal sign */}
        {isPersonalSign && (
          <div className="card" style={{ padding: 12 }}>
            <span className="confirm-label">Message</span>
            <div className="confirm-data mono" style={{ marginTop: 6 }}>
              {request.params?.[0] ?? ''}
            </div>
          </div>
        )}

        {/* Typed data */}
        {isTypedData && (
          <div className="card" style={{ padding: 12 }}>
            <span className="confirm-label">Typed Data</span>
            <pre className="confirm-data mono" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
              {prettyTypedData(request.params?.[1])}
            </pre>
          </div>
        )}

        {/* Add chain details */}
        {isAddChain && (
          <div className="card" style={{ padding: 12 }}>
            <div className="confirm-field">
              <span className="confirm-label">Network Name</span>
              <span className="confirm-value">{tx.chainName}</span>
            </div>
            <div className="confirm-row">
              <div className="confirm-field">
                <span className="confirm-label">Chain ID</span>
                <span className="confirm-value mono">{tx.chainId}</span>
              </div>
              <div className="confirm-field" style={{ textAlign: 'right' }}>
                <span className="confirm-label">Symbol</span>
                <span className="confirm-value">{tx.symbol}</span>
              </div>
            </div>
            <div className="confirm-field" style={{ marginBottom: 0 }}>
              <span className="confirm-label">RPC URL</span>
              <span className="confirm-value mono" style={{ fontSize: 10, wordBreak: 'break-all' }}>{tx.rpcUrl}</span>
            </div>
          </div>
        )}

        {/* Connect request */}
        {isConnect && (
          <div className="card" style={{ padding: 12 }}>
            <p style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 }}>
              <strong>{domain}</strong> wants to connect to your wallet.
            </p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              It will see your account address and can ask you to sign messages and transactions.
              You can disconnect it at any time in Settings → Connected Sites.
            </p>
          </div>
        )}

        {/* Watch asset request */}
        {watchAsset && (
          <div className="card" style={{ padding: 12 }}>
            <div className="confirm-row">
              <div className="confirm-field">
                <span className="confirm-label">Symbol (on-chain)</span>
                <span className="confirm-value">{watchAsset.symbol}</span>
              </div>
              <div className="confirm-field" style={{ textAlign: 'right' }}>
                <span className="confirm-label">Decimals</span>
                <span className="confirm-value mono">{watchAsset.decimals}</span>
              </div>
            </div>
            {watchAsset.name && (
              <div className="confirm-field">
                <span className="confirm-label">Name</span>
                <span className="confirm-value">{watchAsset.name}</span>
              </div>
            )}
            <div className="confirm-field" style={{ marginBottom: 0 }}>
              <span className="confirm-label">Contract</span>
              <span className="confirm-value mono" style={{ fontSize: 10, wordBreak: 'break-all' }}>{watchAsset.address}</span>
            </div>
            {((watchAsset.requestedSymbol !== undefined && watchAsset.requestedSymbol !== watchAsset.symbol)
              || (watchAsset.requestedDecimals !== undefined && watchAsset.requestedDecimals !== watchAsset.decimals)) && (
              <div className="confirm-warning" style={{ fontSize: 11, marginTop: 10 }}>
                The site called this token "{watchAsset.requestedSymbol ?? watchAsset.symbol}"
                {watchAsset.requestedDecimals !== undefined ? ` with ${watchAsset.requestedDecimals} decimals` : ''},
                but the contract says "{watchAsset.symbol}" with {watchAsset.decimals}. The on-chain values are used.
              </div>
            )}
          </div>
        )}

        {/* "Trust this site": time-limited auto-sign (hidden for Ledger — auto-sign would be ineffective) */}
        {canTrust && (
          <div className="card" style={{ padding: 12 }}>
            <div className="settings-row" style={{ padding: 0 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
                  Trust this site
                </p>
                <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  Auto-sign requests from <strong>{domain}</strong> for a limited time
                </p>
              </div>
              <button
                onClick={() => setTrustDurationMs(trustDurationMs === null ? DEFAULT_TRUST_MS : null)}
                className={`toggle ${trustDurationMs !== null ? 'on' : ''}`}
                aria-pressed={trustDurationMs !== null}
              >
                <span className="toggle-knob" />
              </button>
            </div>
            {trustDurationMs !== null && (
              <div className="row gap-xs" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                {TRUST_DURATIONS_MS.map((ms) => (
                  <button
                    key={ms}
                    type="button"
                    onClick={() => setTrustDurationMs(ms)}
                    className={`theme-option ${trustDurationMs === ms ? 'active' : ''}`}
                    aria-pressed={trustDurationMs === ms}
                    style={{ flex: 1, minWidth: 60 }}
                  >
                    {trustDurationLabel(ms)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {isLedger && (
          <div className="confirm-warning" style={{ fontSize: 11 }}>
            <LedgerBadge title="Ledger hardware wallet" /> Approve and confirm on your Ledger device. Make sure the Ethereum app is open.
          </div>
        )}

        {/* Warning */}
        {canTrust && (
          <div className="confirm-warning" style={{ fontSize: 11 }}>
            {trustDurationMs !== null
              ? `Every transaction and signature from this site will be signed without asking for the next ${trustDurationLabel(trustDurationMs)}. Only do this for sites you fully trust.`
              : 'This request is not in your whitelist. Review carefully.'}
          </div>
        )}

        {error && <p className="error-text">{error}</p>}
        {busy && busyMsg && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>{busyMsg}</p>
        )}
      </main>

      {/* Footer */}
      <footer className="confirm-footer">
        <button onClick={reject} disabled={busy} className="btn-secondary" style={{ flex: 1 }}>
          Reject
        </button>
        <button onClick={approve} disabled={busy} className="btn-primary" style={{ flex: 1 }}>
          {busy ? 'Signing…' : approveLabel}
        </button>
      </footer>

      {showJson && (
        <JsonInspector
          request={request}
          approvalDetails={approvalDetails}
          approvalInfo={approvalInfo}
          feeOverride={feeOverride}
          copied={jsonCopied}
          onCopy={async (text) => {
            try {
              await navigator.clipboard.writeText(text);
              setJsonCopied(true);
              setTimeout(() => setJsonCopied(false), 1800);
            } catch {
              // Clipboard API can fail in some contexts; do nothing — the user
              // can still select the text manually.
            }
          }}
          onClose={() => setShowJson(false)}
        />
      )}
    </div>
  );
}

function buildInspectorPayload(
  request: PendingRequest,
  approvalDetails: ApprovalDetails | null,
  approvalInfo: ApprovalTokenInfo | null,
  feeOverride: FeeOverride | null,
): Record<string, unknown> {
  return {
    method: request.method,
    origin: request.origin,
    signerAddress: request.signerAddress,
    chainId: request.chainId,
    chainName: request.chainName,
    params: request.params,
    simulation: request.simulation,
    ledger: request.ledger
      ? {
          derivationPath: request.ledger.derivationPath,
          // Tx body & message hashes — show structure but no private data.
          txJson: request.ledger.txJson,
          messageHex: request.ledger.messageHex,
          domainSeparator: request.ledger.domainSeparator,
          hashStructMessage: request.ledger.hashStructMessage,
        }
      : undefined,
    feeOverride,
    decodedApprove: approvalDetails
      ? {
          tokenAddress: approvalDetails.tokenAddress,
          spender: approvalDetails.spender,
          amountRaw: approvalDetails.amountRaw.toString(),
          tokenSymbol: approvalInfo?.symbol,
          tokenDecimals: approvalInfo?.decimals,
          tokenName: approvalInfo?.name,
          ownerBalanceRaw: approvalInfo?.balanceRaw,
          ownerBalance: approvalInfo?.balance,
        }
      : undefined,
    capturedAt: new Date().toISOString(),
  };
}

function JsonInspector({
  request,
  approvalDetails,
  approvalInfo,
  feeOverride,
  copied,
  onCopy,
  onClose,
}: {
  request: PendingRequest;
  approvalDetails: ApprovalDetails | null;
  approvalInfo: ApprovalTokenInfo | null;
  feeOverride: FeeOverride | null;
  copied: boolean;
  onCopy: (text: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const payload = buildInspectorPayload(request, approvalDetails, approvalInfo, feeOverride);
  const text = JSON.stringify(payload, null, 2);
  return (
    <div className="json-inspector-overlay" onClick={onClose}>
      <div className="json-inspector-panel" onClick={(e) => e.stopPropagation()}>
        <header className="json-inspector-header">
          <div>
            <div className="json-inspector-title">Request JSON</div>
            <div className="json-inspector-subtitle">Copy this and paste into your AI assistant for analysis.</div>
          </div>
          <button type="button" className="btn-secondary json-inspector-close" onClick={onClose}>Close</button>
        </header>
        <pre className="json-inspector-body mono">{text}</pre>
        <footer className="json-inspector-footer">
          <button
            type="button"
            className="btn-primary"
            onClick={() => onCopy(text)}
            style={{ minWidth: 120 }}
          >
            {copied ? 'Copied ✓' : 'Copy JSON'}
          </button>
        </footer>
      </div>
    </div>
  );
}

import { initTheme } from '../popup/theme';
initTheme();

const root = createRoot(document.getElementById('root')!);
root.render(<ConfirmPage />);
