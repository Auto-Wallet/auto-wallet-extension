import React, { useState, useEffect } from 'react';
import { callBackground } from '../api';
import type { TxLogEntry } from '../../lib/tx-logger';
import type { Network } from '../../types/network';
import { ExternalLinkIcon, ZapIcon, BanIcon, CopyIcon, CheckIcon, ChevronDownIcon } from '../icons';

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

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Day-bucket key + human label for grouping the list ("Today" / "Yesterday" / date). */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Compact per-row time: relative for today's entries, clock time otherwise. */
function rowTime(ts: number): string {
  const diff = Date.now() - ts;
  if (new Date(ts).toDateString() === new Date().toDateString()) {
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

/** Visual tone for the status pill. */
function statusTone(entry: TxLogEntry): 'pending' | 'success' | 'danger' | 'muted' {
  if (entry.replacementKind === 'cancel') {
    if (entry.status === 'pending') return 'pending';
    if (entry.status === 'confirmed') return 'muted'; // cancelled — intent fulfilled but nothing happened
    return 'danger';
  }
  if (entry.status === 'pending') return 'pending';
  if (entry.status === 'confirmed') return 'success';
  return 'danger';
}

export function HistoryPage() {
  const [log, setLog] = useState<TxLogEntry[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  // Busy + feedback are keyed by tx id so acting on one row never clobbers
  // another's in-flight state or message.
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // Per-row feedback shown directly under the buttons that triggered it, so the
  // result is visible without scrolling to a top-of-page banner.
  const [rowMsgs, setRowMsgs] = useState<Record<string, { kind: 'ok' | 'err'; text: string }>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // "Clear" is irreversible — require an explicit second click before wiping.
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    loadLog();
    // Pending txs flip to confirmed/failed in the background; refresh so the UI
    // (and the SpeedUp/Cancel buttons) stays in sync without a manual reload.
    const timer = setInterval(loadLog, 5000);
    return () => clearInterval(timer);
  }, []);

  async function loadLog() {
    // Runs on mount and every 5s. callBackground can reject if the service
    // worker is asleep or the extension context was invalidated — swallow it
    // (with a log) so the interval doesn't raise an unhandled rejection, and
    // keep the last-known list on screen rather than blanking it.
    try {
      const [entries, nets] = await Promise.all([
        callBackground<TxLogEntry[]>('getTxLog'),
        callBackground<Network[]>('getNetworks'),
      ]);
      setLog(entries);
      setNetworks(nets);
    } catch (err) {
      console.error('[Auto-Wallet] Failed to refresh transaction history:', err);
    }
  }

  function getExplorerUrl(chainId: number, hash: string): string | null {
    const net = networks.find((n) => n.chainId === chainId);
    if (!net?.blockExplorerUrl) return null;
    return `${net.blockExplorerUrl}/tx/${hash}`;
  }

  function getNetwork(chainId: number): Network | undefined {
    return networks.find((n) => n.chainId === chainId);
  }

  async function manageTx(entry: TxLogEntry, kind: 'speedup' | 'cancel') {
    const action = kind === 'speedup' ? 'speedUpTx' : 'cancelTx';
    console.log(`[Auto-Wallet] ${action} click`, { logId: entry.id, hash: entry.hash, chainId: entry.chainId });
    setBusyMap((prev) => ({ ...prev, [entry.id]: true }));
    setError(null);
    setRowMsgs((prev) => {
      const next = { ...prev };
      delete next[entry.id];
      return next;
    });
    try {
      const res = await callBackground<{ hash: string }>(action, { logId: entry.id });
      console.log(`[Auto-Wallet] ${action} ok`, res);
      setRowMsgs((prev) => ({ ...prev, [entry.id]: { kind: 'ok', text: `Replacement sent: ${res.hash.slice(0, 14)}…` } }));
      await loadLog();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Auto-Wallet] ${action} failed:`, msg);
      setError(msg);
      setRowMsgs((prev) => ({ ...prev, [entry.id]: { kind: 'err', text: msg } }));
    } finally {
      setBusyMap((prev) => ({ ...prev, [entry.id]: false }));
    }
  }

  async function clearLog() {
    await callBackground('clearTxLog');
    setLog([]);
    setConfirmClear(false);
  }

  async function copyAddress(id: string, addr: string) {
    await navigator.clipboard.writeText(addr);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  // Group entries into day buckets (log is already newest-first).
  const groups: { label: string; entries: TxLogEntry[] }[] = [];
  for (const entry of log) {
    const label = dayLabel(entry.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }

  return (
    <div className="stack stack-sm animate-in">
      <div className="row row-between">
        <p className="page-title">Transaction History</p>
        {log.length > 0 && (
          confirmClear ? (
            <span className="row gap-xs">
              <span className="tx-clear-prompt">Clear all?</span>
              <button onClick={clearLog} className="btn-ghost danger">Yes, clear</button>
              <button onClick={() => setConfirmClear(false)} className="btn-ghost">Keep</button>
            </span>
          ) : (
            <button onClick={() => setConfirmClear(true)} className="btn-ghost danger">Clear</button>
          )
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {log.length === 0 && (
        <div className="empty-state">
          No transactions yet
          <div className="empty-state-hint">Transactions you send or auto-sign will show up here.</div>
        </div>
      )}

      {groups.map((group) => (
        <React.Fragment key={group.label}>
          <p className="section-label tx-day-label">{group.label}</p>
          {group.entries.map((entry) => {
            const explorerUrl = entry.hash ? getExplorerUrl(entry.chainId, entry.hash) : null;
            const net = getNetwork(entry.chainId);
            const symbol = net?.symbol ?? '';
            const requestedPrice = entry.maxFeePerGas ?? entry.gasPrice;
            const busy = !!busyMap[entry.id];
            const rowMsg = rowMsgs[entry.id];
            const isOpen = !!expanded[entry.id];
            const tone = statusTone(entry);
            // Show actions on every pending row; the background validates whether
            // this account can actually replace it and returns a clear error if not.
            const manageable = entry.status === 'pending';
            const isZeroValue = !entry.value || entry.value === '0';
            // Contract deployments have no recipient (to is null in the raw tx).
            const headline = entry.replacementKind === 'cancel'
              ? 'Cancel transaction'
              : !entry.to
                ? 'Contract deployment'
                : isZeroValue
                  ? 'Contract call'
                  : `−${formatNative(entry.value)} ${symbol}`.trim();
            return (
              <div key={entry.id} className="card tx-card">
                <div className="row row-between tx-card-head">
                  <span className="row gap-xs">
                    <span className={`tx-status tx-status-${tone}`}>
                      <span className="tx-status-dot" />
                      {statusLabel(entry)}
                    </span>
                    <span className={`badge ${entry.autoSigned ? 'badge-auto' : 'badge-manual'}`}>
                      {entry.autoSigned ? 'Auto' : 'Manual'}
                    </span>
                    {entry.replacementKind === 'speedup' && (
                      <span className="badge badge-network">Sped up</span>
                    )}
                  </span>
                  <span className="tx-time" title={new Date(entry.timestamp).toLocaleString()}>
                    {rowTime(entry.timestamp)}
                  </span>
                </div>

                <div className="row row-between tx-card-main">
                  <div className="tx-card-summary">
                    <div className="tx-amount">{headline}</div>
                    {entry.to && (
                      <div className="tx-to">
                        to <span className="mono">{shortAddr(entry.to)}</span>
                        <button
                          className="tx-copy-btn"
                          onClick={() => copyAddress(entry.id, entry.to)}
                          title={`Copy ${entry.to}`}
                          aria-label="Copy recipient address"
                        >
                          {copiedId === entry.id ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
                        </button>
                      </div>
                    )}
                  </div>
                  <span className="row tx-card-actions">
                    {explorerUrl && (
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tx-detail-toggle tx-explorer-btn"
                        title="View on block explorer"
                        aria-label="View on block explorer"
                      >
                        <ExternalLinkIcon size={13} />
                      </a>
                    )}
                    <button
                      className={`tx-detail-toggle ${isOpen ? 'open' : ''}`}
                      onClick={() => toggleExpanded(entry.id)}
                      title={isOpen ? 'Hide details' : 'Show details'}
                      aria-label={isOpen ? 'Hide details' : 'Show details'}
                      aria-expanded={isOpen}
                    >
                      <ChevronDownIcon size={14} />
                    </button>
                  </span>
                </div>

                <div className="row row-between tx-card-meta">
                  <span className="truncate">{net?.name ?? `Chain ${entry.chainId}`}</span>
                  <span className="truncate" style={{ textAlign: 'right' }}>{entry.origin}</span>
                </div>

                {isOpen && (
                  <div className="rule-detail tx-details">
                    {entry.to && <div className="truncate">to: {entry.to}</div>}
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
                    {entry.nonce !== undefined && <div>nonce: {entry.nonce}</div>}
                  </div>
                )}

                {manageable && (
                  <div className="row tx-actions">
                    <button
                      onClick={() => manageTx(entry, 'speedup')}
                      disabled={busy}
                      className="btn-ghost accent tx-action-btn"
                      title="Re-send at the same nonce — you set the gas price in the confirm popup"
                    >
                      <ZapIcon size={12} /> {busy ? 'Working…' : 'Speed Up'}
                    </button>
                    <button
                      onClick={() => manageTx(entry, 'cancel')}
                      disabled={busy}
                      className="btn-ghost danger tx-action-btn"
                      title="Replace with a 0-value self-transfer — you set the gas price in the confirm popup"
                    >
                      <BanIcon size={12} /> Cancel
                    </button>
                  </div>
                )}
                {busy && (
                  <div className="tx-row-note">
                    Set the gas price and confirm in the popup window…
                  </div>
                )}
                {rowMsg && !busy && (
                  rowMsg.kind === 'ok' && entry.hash ? (
                    <div className="tx-row-note" style={{ color: 'var(--success)' }}>
                      ✓ Replacement sent — track: <HashLink hash={entry.hash} url={explorerUrl} />
                    </div>
                  ) : (
                    <div className="tx-row-note" style={{ color: 'var(--danger)', wordBreak: 'break-word' }}>
                      {rowMsg.text}
                    </div>
                  )
                )}
              </div>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}
