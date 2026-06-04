import React, { useState, useEffect } from 'react';
import { callBackground } from '../api';
import type { TxLogEntry } from '../../lib/tx-logger';
import type { Network } from '../../types/network';
import { ExternalLinkIcon, ZapIcon, BanIcon } from '../icons';

const GWEI = 1_000_000_000n;

function formatNative(wei: string | undefined, decimals = 18): string {
  if (!wei) return '—';
  try {
    const n = BigInt(wei);
    if (n === 0n) return '0';
    const divisor = 10n ** BigInt(decimals);
    const whole = n / divisor;
    const remainder = n % divisor;
    if (remainder === 0n) return whole.toString();
    const fracStr = remainder.toString().padStart(decimals, '0').slice(0, 8).replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch { return '—'; }
}

function formatGwei(wei: string | undefined): string {
  if (!wei) return '—';
  try {
    const n = BigInt(wei);
    const whole = n / GWEI;
    const remainder = n % GWEI;
    if (remainder === 0n) return `${whole}`;
    const fracStr = remainder.toString().padStart(9, '0').slice(0, 4).replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : `${whole}`;
  } catch { return '—'; }
}

/** A tx hash rendered as an explorer link (or plain mono text when no explorer). */
function HashLink({ hash, url, short = true }: { hash: string; url: string | null; short?: boolean }) {
  const text = short ? `${hash.slice(0, 14)}…${hash.slice(-8)}` : hash;
  if (!url) return <span className="mono" style={{ wordBreak: 'break-all' }}>{text}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="tx-link">
      {text}
      <ExternalLinkIcon size={11} className="tx-link-icon" />
    </a>
  );
}

/** Human-readable status, accounting for cancellation replacements. */
function statusLabel(entry: TxLogEntry): string {
  if (entry.replacementKind === 'cancel') {
    if (entry.status === 'pending') return 'cancelling';
    if (entry.status === 'confirmed') return 'cancelled';
    if (entry.status === 'failed') return 'cancel failed';
  }
  return entry.status;
}

export function HistoryPage() {
  const [log, setLog] = useState<TxLogEntry[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-row feedback shown directly under the buttons that triggered it, so the
  // result is visible without scrolling to a top-of-page banner.
  const [rowMsg, setRowMsg] = useState<{ id: string; kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    loadLog();
    // Pending txs flip to confirmed/failed in the background; refresh so the UI
    // (and the SpeedUp/Revoke buttons) stays in sync without a manual reload.
    const timer = setInterval(loadLog, 5000);
    return () => clearInterval(timer);
  }, []);

  async function loadLog() {
    const [entries, nets] = await Promise.all([
      callBackground<TxLogEntry[]>('getTxLog'),
      callBackground<Network[]>('getNetworks'),
    ]);
    setLog(entries);
    setNetworks(nets);
  }

  function getExplorerUrl(chainId: number, hash: string): string | null {
    const net = networks.find((n) => n.chainId === chainId);
    if (!net?.blockExplorerUrl) return null;
    return `${net.blockExplorerUrl}/tx/${hash}`;
  }

  function getSymbol(chainId: number): string {
    return networks.find((n) => n.chainId === chainId)?.symbol ?? '';
  }

  async function manageTx(entry: TxLogEntry, kind: 'speedup' | 'cancel') {
    const action = kind === 'speedup' ? 'speedUpTx' : 'cancelTx';
    console.log(`[Auto-Wallet] ${action} click`, { logId: entry.id, hash: entry.hash, chainId: entry.chainId });
    setBusyId(entry.id);
    setError(null);
    setRowMsg(null);
    try {
      const res = await callBackground<{ hash: string }>(action, { logId: entry.id });
      console.log(`[Auto-Wallet] ${action} ok`, res);
      setRowMsg({ id: entry.id, kind: 'ok', text: `Replacement sent: ${res.hash.slice(0, 14)}…` });
      await loadLog();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Auto-Wallet] ${action} failed:`, msg);
      setError(msg);
      setRowMsg({ id: entry.id, kind: 'err', text: msg });
    } finally {
      setBusyId(null);
    }
  }

  async function clearLog() {
    await callBackground('clearTxLog');
    setLog([]);
  }

  return (
    <div className="stack stack-sm animate-in">
      <div className="row row-between">
        <p className="page-title">Transaction History</p>
        {log.length > 0 && (
          <button onClick={clearLog} className="btn-ghost danger">Clear</button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {log.length === 0 && (
        <div className="empty-state">No transactions yet</div>
      )}

      {log.map((entry) => {
        const explorerUrl = entry.hash ? getExplorerUrl(entry.chainId, entry.hash) : null;
        const symbol = getSymbol(entry.chainId);
        const requestedPrice = entry.maxFeePerGas ?? entry.gasPrice;
        // Show actions on every pending row; the background validates whether
        // this account can actually replace it and returns a clear error if not.
        const manageable = entry.status === 'pending';
        return (
          <div key={entry.id} className="card">
            <div className="row row-between" style={{ marginBottom: 8 }}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <span className={`badge ${entry.autoSigned ? 'badge-auto' : 'badge-manual'}`}>
                  {entry.autoSigned ? 'Auto' : 'Manual'}
                </span>
                {entry.replacementKind && (
                  <span className={`badge ${entry.replacementKind === 'cancel' ? 'badge-manual' : 'badge-network'}`}>
                    {entry.replacementKind === 'cancel' ? 'Cancel' : 'Sped up'}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {new Date(entry.timestamp).toLocaleString()}
              </span>
            </div>
            <div className="rule-detail">
              <div className="truncate">to: {entry.to}</div>
              {entry.hash && (
                <div className="truncate">
                  {entry.replacementKind === 'cancel'
                    ? 'cancel tx'
                    : entry.replacementKind === 'speedup'
                      ? 'new tx'
                      : 'tx'}
                  : <HashLink hash={entry.hash} url={explorerUrl} />
                </div>
              )}
              {entry.prevHash && (
                <div className="truncate" style={{ color: 'var(--text-muted)' }}>
                  replaces:{' '}
                  <HashLink hash={entry.prevHash} url={getExplorerUrl(entry.chainId, entry.prevHash)} />
                </div>
              )}
              {(entry.gasLimit || requestedPrice) && (
                <div className="truncate">
                  requested: {entry.gasLimit ?? '?'} gas
                  {requestedPrice ? ` @ ${formatGwei(requestedPrice)} gwei` : ''}
                  {entry.maxPriorityFeePerGas ? ` (tip ${formatGwei(entry.maxPriorityFeePerGas)})` : ''}
                </div>
              )}
              {entry.feeWei && (
                <div className="truncate">
                  paid: {formatNative(entry.feeWei)} {symbol}
                  {entry.gasUsed ? ` · ${entry.gasUsed} gas` : ''}
                  {entry.effectiveGasPrice ? ` @ ${formatGwei(entry.effectiveGasPrice)} gwei` : ''}
                </div>
              )}
            </div>
            <div className="row row-between" style={{ marginTop: 6 }}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                chain {entry.chainId}
                {entry.nonce !== undefined ? ` · nonce ${entry.nonce}` : ''} · {statusLabel(entry)}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }} className="truncate">{entry.origin}</span>
            </div>

            {manageable && (
              <div className="row tx-actions">
                <button
                  onClick={() => manageTx(entry, 'speedup')}
                  disabled={busyId === entry.id}
                  className="btn-ghost accent tx-action-btn"
                  title="Re-send at the same nonce — you set the gas price in the confirm popup"
                >
                  <ZapIcon size={12} /> {busyId === entry.id ? 'Working…' : 'Speed Up'}
                </button>
                <button
                  onClick={() => manageTx(entry, 'cancel')}
                  disabled={busyId === entry.id}
                  className="btn-ghost danger tx-action-btn"
                  title="Replace with a 0-value self-transfer — you set the gas price in the confirm popup"
                >
                  <BanIcon size={12} /> Revoke
                </button>
              </div>
            )}
            {busyId === entry.id && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                Set the gas price and confirm in the popup window…
              </div>
            )}
            {rowMsg?.id === entry.id && busyId !== entry.id && (
              rowMsg.kind === 'ok' && entry.hash ? (
                <div style={{ fontSize: 10, marginTop: 6, color: 'var(--success)' }}>
                  ✓ Replacement sent — track: <HashLink hash={entry.hash} url={explorerUrl} />
                </div>
              ) : (
                <div style={{ fontSize: 10, marginTop: 6, color: 'var(--danger)', wordBreak: 'break-word' }}>
                  {rowMsg.text}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
