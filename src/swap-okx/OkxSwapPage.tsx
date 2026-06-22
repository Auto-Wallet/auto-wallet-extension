import React, { useEffect, useMemo, useRef, useState } from 'react';
import { callBackground } from '../popup/api';
import {
  ArrowDownIcon,
  ChevronDownIcon,
  CloseIcon,
  ExternalLinkIcon,
  SearchIcon,
} from '../popup/icons';
import {
  okxApproveTransaction,
  okxHistory,
  okxIsNative,
  okxQuote,
  okxSupportedChains,
  okxSwap,
  okxTokens,
  okxTokenDecimals,
  OKX_NATIVE_TOKEN_ADDRESS,
  type OkxChain,
  type OkxHistory,
  type OkxQuote,
  type OkxToken,
} from '../lib/okxDex';
import type { Network } from '../types/network';
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, toHex } from 'viem';

interface ActiveInfo {
  id: string;
  label: string;
  address: string;
  type: 'private' | 'ledger' | 'watchOnly';
  derivationPath?: string;
}

type PickerSide = 'from' | 'to' | null;

type Stage =
  | { kind: 'idle' }
  | { kind: 'approving' }
  | { kind: 'swapping' }
  | { kind: 'submitted'; hash: string }
  | { kind: 'error'; message: string };

const SLIPPAGE_OPTIONS = ['0.5', '1', '3'];
const QUOTE_DEBOUNCE_MS = 700;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** OKX uses 0xeee… for native; the wallet's balance lookup expects 0x0…0. */
function walletTokenAddress(okxAddress: string): string {
  return okxIsNative(okxAddress) ? ZERO_ADDRESS : okxAddress;
}

function nativeOkxToken(net: Network): OkxToken {
  return {
    chainIndex: String(net.chainId),
    decimals: String(net.decimals),
    tokenContractAddress: OKX_NATIVE_TOKEN_ADDRESS,
    tokenName: net.symbol,
    tokenSymbol: net.symbol,
  };
}

function trimAmount(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function routeLabel(quote: OkxQuote | null): string {
  if (!quote?.dexRouterList?.length) return 'OKX DEX';
  const names = new Set<string>();
  for (const route of quote.dexRouterList) {
    const name = route.dexProtocol?.dexName;
    if (name) names.add(name);
  }
  const list = [...names];
  if (list.length === 0) return 'OKX DEX';
  if (list.length <= 2) return list.join(' + ');
  return `${list.slice(0, 2).join(' + ')} +${list.length - 2}`;
}

export function OkxSwapPage() {
  const [active, setActive] = useState<ActiveInfo | null>(null);
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [chainOptions, setChainOptions] = useState<Network[]>([]);
  const [okxChainMeta, setOkxChainMeta] = useState<Map<string, OkxChain>>(new Map());
  // Cache of resolved approve spenders (dexTokenApproveAddress) per chainId.
  const spenderByChainRef = useRef<Map<number, string>>(new Map());

  const [chainId, setChainId] = useState<number | null>(null);
  const [showChainMenu, setShowChainMenu] = useState(false);

  const [tokens, setTokens] = useState<OkxToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [from, setFrom] = useState<OkxToken | null>(null);
  const [to, setTo] = useState<OkxToken | null>(null);
  const [picker, setPicker] = useState<PickerSide>(null);

  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('1');

  const [balanceRaw, setBalanceRaw] = useState<bigint | null>(null);
  const [balance, setBalance] = useState('');
  const [allowance, setAllowance] = useState<bigint | null>(null);

  const [quote, setQuote] = useState<OkxQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [status, setStatus] = useState<OkxHistory | null>(null);
  const pollSeqRef = useRef(0);
  const quoteSeqRef = useRef(0);

  const selectedNetwork = useMemo(
    () => chainOptions.find((n) => n.chainId === chainId) ?? null,
    [chainOptions, chainId],
  );

  const fromDecimals = okxTokenDecimals(from);
  const toDecimals = okxTokenDecimals(to);

  const amountRaw = useMemo(() => {
    if (!amount.trim() || !from) return null;
    try {
      const raw = parseUnits(amount.trim(), fromDecimals);
      return raw > 0n ? raw : null;
    } catch {
      return null;
    }
  }, [amount, from, fromDecimals]);

  const insufficient = useMemo(() => {
    if (amountRaw === null || balanceRaw === null) return false;
    return amountRaw > balanceRaw;
  }, [amountRaw, balanceRaw]);

  const needsApprove = useMemo(() => {
    if (!from || okxIsNative(from.tokenContractAddress)) return false;
    if (amountRaw === null || allowance === null) return false;
    return allowance < amountRaw;
  }, [from, amountRaw, allowance]);

  // OKX's `slippagePercent` param is the percent value itself (e.g. "1" = 1%),
  // matching the desktop reference. Valid range is 0.01%–50%.
  const slippagePct = useMemo(() => {
    const n = Number(slippage);
    return Number.isFinite(n) && n >= 0.01 && n <= 50 ? n : null;
  }, [slippage]);

  const amountOut = useMemo(() => {
    if (!quote || !to) return '';
    try {
      return trimAmount(formatUnits(BigInt(quote.toTokenAmount), toDecimals));
    } catch {
      return '';
    }
  }, [quote, to, toDecimals]);

  // --- Initial load: account, unlock state, networks -----------------------
  useEffect(() => {
    (async () => {
      const [info, isUnlocked, nets] = await Promise.all([
        callBackground<ActiveInfo>('getActiveAccountInfo').catch(() => null),
        callBackground<boolean>('isUnlocked').catch(() => false),
        callBackground<Network[]>('getNetworks').catch(() => [] as Network[]),
      ]);
      setActive(info);
      setUnlocked(isUnlocked);

      // Offer every network the wallet can send on. OKX supports all major EVM
      // chains; if a particular chain/pair isn't supported the quote call simply
      // returns an error, which is recoverable — unlike hard-gating the whole
      // list on the supported-chain endpoint (which dead-ends the page if that
      // response ever shifts shape).
      setChainOptions(nets);
      if (nets.length > 0) {
        const activeNet = await callBackground<Network>('getActiveNetwork').catch(() => null);
        const preferred = activeNet && nets.some((o) => o.chainId === activeNet.chainId)
          ? activeNet.chainId
          : nets[0]!.chainId;
        setChainId(preferred);
      }

      // Best-effort: learn each chain's approve spender (dexTokenApproveAddress).
      // Non-fatal — okxApproveTransaction also returns the spender on demand.
      try {
        const okxChains = await okxSupportedChains();
        const meta = new Map<string, OkxChain>();
        for (const c of okxChains) {
          const key = c.chainIndex ?? c.chainId;
          if (key) meta.set(key, c);
        }
        setOkxChainMeta(meta);
      } catch {
        // ignore — spender is resolved lazily in the allowance effect
      }
    })();
  }, []);

  // --- Load tokens when the chain changes ----------------------------------
  useEffect(() => {
    if (!selectedNetwork) return;
    let cancelled = false;
    setTokensLoading(true);
    setTokens([]);
    setFrom(nativeOkxToken(selectedNetwork));
    setTo(null);
    setAmount('');
    setQuote(null);
    setQuoteError(null);
    setStage({ kind: 'idle' });
    setStatus(null);
    (async () => {
      try {
        const list = await okxTokens(String(selectedNetwork.chainId));
        if (cancelled) return;
        // OKX's all-tokens list doesn't always include the native coin; make
        // sure it's selectable (e.g. as the receive side of USDC→ETH).
        const hasNative = list.some((t) => okxIsNative(t.tokenContractAddress));
        setTokens(hasNative ? list : [nativeOkxToken(selectedNetwork), ...list]);
      } catch {
        if (!cancelled) setTokens([]);
      } finally {
        if (!cancelled) setTokensLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedNetwork]);

  // --- Balance of the from-token -------------------------------------------
  useEffect(() => {
    if (!from || !active || !selectedNetwork) { setBalance(''); setBalanceRaw(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const info = await callBackground<{ balance: string; balanceRaw: string; decimals: number }>(
          'getBalanceForChain',
          {
            chainId: selectedNetwork.chainId,
            owner: active.address,
            tokenAddress: walletTokenAddress(from.tokenContractAddress),
          },
        );
        if (cancelled) return;
        setBalance(trimAmount(info.balance));
        setBalanceRaw(BigInt(info.balanceRaw));
      } catch {
        if (!cancelled) { setBalance(''); setBalanceRaw(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [from, active, selectedNetwork]);

  // --- Allowance for ERC20 from-tokens -------------------------------------
  useEffect(() => {
    if (!from || !active || !selectedNetwork) { setAllowance(null); return; }
    if (okxIsNative(from.tokenContractAddress)) { setAllowance(0n); return; }
    if (amountRaw === null) { setAllowance(null); return; }
    let cancelled = false;
    (async () => {
      const spender = await resolveSpender(selectedNetwork, from.tokenContractAddress, amountRaw);
      if (cancelled) return;
      if (!spender) { setAllowance(null); return; }
      try {
        const raw = await callBackground<string>('getErc20Allowance', {
          chainId: selectedNetwork.chainId,
          tokenAddress: from.tokenContractAddress,
          owner: active.address,
          spender,
        });
        if (!cancelled) setAllowance(BigInt(raw));
      } catch {
        if (!cancelled) setAllowance(null);
      }
    })();
    return () => { cancelled = true; };
    // `stage` is intentionally excluded: performApprove sets the allowance to
    // MAX itself after the receipt lands, so re-reading on every stage change
    // would only risk overwriting it with a not-yet-mined (stale) value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, active, selectedNetwork, amountRaw, okxChainMeta]);

  /**
   * Resolve the OKX approve spender for a chain: prefer the supported-chain
   * metadata, fall back to a cached value, then learn it from
   * okxApproveTransaction (whose `dexContractAddress` is the same router) and
   * cache it. Constant per chain, so the lazy fetch happens at most once.
   */
  async function resolveSpender(net: Network, tokenAddr: string, amountForProbe: bigint): Promise<string | null> {
    const metaSpender = okxChainMeta.get(String(net.chainId))?.dexTokenApproveAddress;
    if (metaSpender) return metaSpender;
    const cached = spenderByChainRef.current.get(net.chainId);
    if (cached) return cached;
    try {
      const tx = await okxApproveTransaction(String(net.chainId), tokenAddr, amountForProbe.toString());
      if (tx.dexContractAddress) {
        spenderByChainRef.current.set(net.chainId, tx.dexContractAddress);
        return tx.dexContractAddress;
      }
    } catch {
      // OKX may not support this chain/token — leave the spender unknown.
    }
    return null;
  }

  // --- Quote (debounced) ---------------------------------------------------
  useEffect(() => {
    if (!from || !to || !selectedNetwork || amountRaw === null) {
      setQuote(null);
      setQuoteError(null);
      setQuoting(false);
      return;
    }
    if (from.tokenContractAddress.toLowerCase() === to.tokenContractAddress.toLowerCase()) {
      setQuote(null);
      setQuoteError('Choose two different tokens.');
      return;
    }
    const seq = ++quoteSeqRef.current;
    setQuoting(true);
    setQuoteError(null);
    const handle = setTimeout(async () => {
      try {
        const q = await okxQuote({
          chainIndex: String(selectedNetwork.chainId),
          amount: amountRaw.toString(),
          fromTokenAddress: from.tokenContractAddress,
          toTokenAddress: to.tokenContractAddress,
          swapMode: 'exactIn',
        });
        if (seq !== quoteSeqRef.current) return;
        setQuote(q);
      } catch (e: any) {
        if (seq !== quoteSeqRef.current) return;
        setQuote(null);
        setQuoteError(e?.message ?? 'No quote available');
      } finally {
        if (seq === quoteSeqRef.current) setQuoting(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [from, to, selectedNetwork, amountRaw]);

  function setMax() {
    if (balanceRaw === null || !from) return;
    setAmount(trimAmount(formatUnits(balanceRaw, fromDecimals)));
  }

  function flip() {
    if (!from || !to) return;
    setFrom(to);
    setTo(from);
    setAmount('');
    setQuote(null);
  }

  async function performApprove() {
    if (!from || !active || !selectedNetwork || amountRaw === null) return;
    setStage({ kind: 'approving' });
    try {
      const spenderStr = await resolveSpender(selectedNetwork, from.tokenContractAddress, amountRaw);
      if (!spenderStr) throw new Error('Could not determine the OKX approve spender for this token.');
      const spender = spenderStr as `0x${string}`;
      const tokenAddr = from.tokenContractAddress as `0x${string}`;
      const chainId = selectedNetwork.chainId;

      // USDT-style tokens revert when moving a non-zero allowance to a new
      // non-zero value, so reset to 0 first — and wait for it to land before
      // sending the real approve.
      if (allowance !== null && allowance > 0n) {
        const resetData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] });
        const resetHash = await callBackground<string>('submitTxViaConfirm', {
          chainId,
          origin: 'Auto Wallet Swap · OKX Approve(0)',
          tx: { from: active.address, to: tokenAddr, data: resetData, value: '0x0' },
        });
        await callBackground('waitForReceipt', { chainId, hash: resetHash });
      }

      // Approve exactly the amount this swap needs — no unlimited allowance left
      // sitting on the token after the trade.
      const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amountRaw] });
      const approveHash = await callBackground<string>('submitTxViaConfirm', {
        chainId,
        origin: 'Auto Wallet Swap · OKX Approve',
        tx: { from: active.address, to: tokenAddr, data: approveData, value: '0x0' },
      });
      // Only advance to Swap once the approve is actually mined — broadcasting
      // alone leaves the on-chain allowance unchanged, which is what made the
      // button flip back to "Approve".
      const receipt = await callBackground<{ status: string }>('waitForReceipt', { chainId, hash: approveHash });
      if (receipt.status !== 'success') throw new Error('Approval transaction failed on-chain.');

      setAllowance(amountRaw);
      setStage({ kind: 'idle' });
    } catch (e: any) {
      setStage({ kind: 'error', message: e?.message ?? 'Approve rejected' });
    }
  }

  async function performSwap() {
    if (!from || !to || !active || !selectedNetwork || amountRaw === null) return;
    if (insufficient) { setStage({ kind: 'error', message: 'Insufficient balance' }); return; }
    if (slippagePct === null) { setStage({ kind: 'error', message: 'Invalid slippage' }); return; }
    pollSeqRef.current += 1;
    setStatus(null);
    setStage({ kind: 'swapping' });
    try {
      const prepared = await okxSwap({
        chainIndex: String(selectedNetwork.chainId),
        amount: amountRaw.toString(),
        fromTokenAddress: from.tokenContractAddress,
        toTokenAddress: to.tokenContractAddress,
        swapMode: 'exactIn',
        slippagePercent: String(slippagePct),
        userWalletAddress: active.address,
      });
      const tx = prepared.tx;
      const valueHex = (() => {
        const v = tx.value;
        if (!v || v === '0') return '0x0';
        if (v.startsWith('0x')) return v;
        try { return toHex(BigInt(v)); } catch { return '0x0'; }
      })();
      const hash = await callBackground<string>('submitTxViaConfirm', {
        chainId: selectedNetwork.chainId,
        origin: `Auto Wallet Swap · OKX (${from.tokenSymbol}→${to.tokenSymbol})`,
        tx: { from: active.address, to: tx.to, data: tx.data || '0x', value: valueHex },
      });
      setStage({ kind: 'submitted', hash });
      setAmount('');
      setQuote(null);
      pollStatus(String(selectedNetwork.chainId), hash);
    } catch (e: any) {
      setStage({ kind: 'error', message: e?.message ?? 'Swap failed' });
    }
  }

  async function pollStatus(chainIndex: string, hash: string) {
    const mySeq = ++pollSeqRef.current;
    const MAX_ATTEMPTS = 120; // 5s × 120 = 10 min
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (mySeq !== pollSeqRef.current) return;
      try {
        const h = await okxHistory(chainIndex, hash);
        if (mySeq !== pollSeqRef.current) return;
        if (h) {
          setStatus(h);
          if (h.status === 'success' || h.status === 'fail') return;
        }
      } catch {
        // OKX lags the source chain for the first blocks — keep polling.
      }
    }
  }

  const explorerTxUrl = selectedNetwork?.blockExplorerUrl && stage.kind === 'submitted'
    ? `${selectedNetwork.blockExplorerUrl.replace(/\/$/, '')}/tx/${stage.hash}`
    : null;

  if (unlocked === false) {
    return (
      <div className="swap-shell">
        <Header active={active} network={selectedNetwork} />
        <div className="swap-locked">Wallet is locked. Open the extension popup and unlock to swap.</div>
      </div>
    );
  }

  return (
    <div className="swap-shell">
      <Header active={active} network={selectedNetwork} />
      <main className="swap-main">
        {chainOptions.length === 0 ? (
          <div className="swap-locked">
            No networks configured. Add an EVM network in Settings → Networks, then reopen Swap.
          </div>
        ) : (
          <>
            {/* Network selector */}
            <div className="okx-chain-select">
              <span className="swap-side-label">Network</span>
              <div className="okx-chain-dropdown">
                <button className="okx-chain-trigger" onClick={() => setShowChainMenu((v) => !v)}>
                  <span>{selectedNetwork?.name ?? 'Select network'}</span>
                  <ChevronDownIcon size={16} />
                </button>
                {showChainMenu && (
                  <>
                  <div className="okx-chain-backdrop" onClick={() => setShowChainMenu(false)} />
                  <div className="okx-chain-menu">
                    {chainOptions.map((n) => (
                      <button
                        key={n.chainId}
                        className={`okx-chain-option${n.chainId === chainId ? ' is-active' : ''}`}
                        onClick={() => { setChainId(n.chainId); setShowChainMenu(false); }}
                      >
                        <span>{n.name}</span>
                        <span className="okx-chain-option-id mono">{n.chainId}</span>
                      </button>
                    ))}
                  </div>
                  </>
                )}
              </div>
            </div>

            {/* Swap card */}
            <div className="swap-card">
              <div className="swap-side">
                <div className="swap-side-label">You pay</div>
                <div className="swap-side-row">
                  <input
                    className="swap-amount-input"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  />
                  <TokenPill token={from} onClick={() => setPicker('from')} />
                </div>
                <div className="swap-side-meta">
                  <span className="swap-side-meta-muted">
                    Balance: {balance || '—'} {from?.tokenSymbol ?? ''}
                  </span>
                  {balanceRaw !== null && balanceRaw > 0n && (
                    <button className="swap-max-btn" onClick={setMax}>MAX</button>
                  )}
                </div>
              </div>

              <button className="swap-flip" onClick={flip} title="Flip tokens">
                <ArrowDownIcon size={16} />
              </button>

              <div className="swap-side">
                <div className="swap-side-label">You receive</div>
                <div className="swap-side-row">
                  <div className="swap-amount-readonly">
                    {amountOut ? amountOut : <span className="swap-amount-placeholder">0.0</span>}
                  </div>
                  <TokenPill token={to} onClick={() => setPicker('to')} placeholder="Select" />
                </div>
                <div className="swap-side-meta">
                  <span className="swap-side-meta-muted">
                    {quoting ? 'Fetching best price…' : quote ? `via ${routeLabel(quote)}` : ' '}
                  </span>
                </div>
              </div>
            </div>

            {/* Slippage */}
            <div className="swap-summary">
              <div className="swap-summary-row">
                <span>Slippage tolerance</span>
                <div className="swap-slippage">
                  {SLIPPAGE_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      className={`swap-slippage-pill${slippage === opt ? ' is-active' : ''}`}
                      onClick={() => setSlippage(opt)}
                    >
                      {opt}%
                    </button>
                  ))}
                  <input
                    className="input-field swap-slippage-input"
                    value={slippage}
                    onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, ''))}
                  />
                </div>
              </div>
              {quote && (
                <>
                  <div className="swap-summary-row">
                    <span>Rate</span>
                    <span className="swap-summary-value">
                      1 {from?.tokenSymbol} ≈ {rate(quote, fromDecimals, toDecimals)} {to?.tokenSymbol}
                    </span>
                  </div>
                  {quote.priceImpactPercent && (
                    <div className="swap-summary-row">
                      <span>Price impact</span>
                      <span className={`swap-summary-value${Math.abs(Number(quote.priceImpactPercent)) >= 5 ? ' is-warn' : ''}`}>
                        {Number(quote.priceImpactPercent).toFixed(2)}%
                      </span>
                    </div>
                  )}
                  {quote.tradeFee && Number.isFinite(Number(quote.tradeFee)) && (
                    <div className="swap-summary-row">
                      <span>Network fee</span>
                      {/* OKX returns tradeFee as a USD value (matches desktop). */}
                      <span className="swap-summary-value">${Number(quote.tradeFee).toFixed(2)}</span>
                    </div>
                  )}
                </>
              )}
              {quoteError && <div className="swap-summary-error">{quoteError}</div>}
            </div>

            {/* Actions */}
            <div className="swap-actions">
              {needsApprove ? (
                <button
                  className="btn-primary swap-btn"
                  disabled={stage.kind === 'approving' || !amountRaw || insufficient}
                  onClick={performApprove}
                >
                  {stage.kind === 'approving' ? 'Approving…' : `Approve ${from?.tokenSymbol}`}
                </button>
              ) : (
                <button
                  className="btn-primary swap-btn"
                  disabled={
                    stage.kind === 'swapping' || !quote || !amountRaw || insufficient ||
                    quoting || slippagePct === null
                  }
                  onClick={performSwap}
                >
                  {stage.kind === 'swapping'
                    ? 'Swapping…'
                    : insufficient
                      ? `Insufficient ${from?.tokenSymbol ?? ''}`
                      : 'Swap'}
                </button>
              )}
            </div>

            {/* Status */}
            {stage.kind === 'error' && (
              <div className="swap-status swap-status-error">
                <span>{stage.message}</span>
              </div>
            )}
            {stage.kind === 'submitted' && (
              <div className="swap-status-card">
                <div className={`swap-status-banner ${status?.status === 'success' ? 'is-success' : status?.status === 'fail' ? 'is-error' : 'is-info'}`}>
                  {!status || status.status === 'pending' ? (
                    <><span className="swap-status-spinner" />Swap submitted — settling on-chain…</>
                  ) : status.status === 'success' ? (
                    'Swap complete'
                  ) : (
                    `Swap failed${status.errorMsg ? `: ${status.errorMsg}` : ''}`
                  )}
                </div>
                {explorerTxUrl && (
                  <a className="tx-link" href={explorerTxUrl} target="_blank" rel="noreferrer">
                    {shortAddr(stage.hash)}
                    <ExternalLinkIcon size={12} />
                  </a>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {picker && selectedNetwork && (
        <TokenPickerModal
          tokens={tokens}
          loading={tokensLoading}
          excludeAddress={(picker === 'from' ? to : from)?.tokenContractAddress}
          onClose={() => setPicker(null)}
          onSelect={(token) => {
            if (picker === 'from') setFrom(token);
            else setTo(token);
            setPicker(null);
            setQuote(null);
          }}
        />
      )}
    </div>
  );
}

function rate(quote: OkxQuote, fromDecimals: number, toDecimals: number): string {
  try {
    const inAmt = Number(formatUnits(BigInt(quote.fromTokenAmount), fromDecimals));
    const outAmt = Number(formatUnits(BigInt(quote.toTokenAmount), toDecimals));
    if (!inAmt) return '0';
    const r = outAmt / inAmt;
    return r >= 1 ? r.toFixed(4) : r.toPrecision(4);
  } catch {
    return '0';
  }
}

function Header({ active, network }: { active: ActiveInfo | null; network: Network | null }) {
  return (
    <header className="swap-header">
      <div className="swap-header-left">
        <span className="swap-header-title">Swap</span>
        <span className="swap-header-sub">OKX DEX Aggregator{network ? ` · ${network.name}` : ''}</span>
      </div>
      {active && <span className="swap-header-addr mono">{shortAddr(active.address)}</span>}
    </header>
  );
}

function TokenPill({
  token,
  onClick,
  placeholder = 'Token',
}: {
  token: OkxToken | null;
  onClick: () => void;
  placeholder?: string;
}) {
  return (
    <button className="swap-token-pill" onClick={onClick}>
      {token ? (
        <>
          <TokenMark token={token} size={20} />
          <span className="swap-token-pill-text">
            <span className="swap-token-symbol">{token.tokenSymbol}</span>
          </span>
        </>
      ) : (
        <span className="swap-token-placeholder">{placeholder}</span>
      )}
      <ChevronDownIcon size={14} />
    </button>
  );
}

function TokenMark({ token, size }: { token: OkxToken; size: number }) {
  const [failed, setFailed] = useState(false);
  if (token.tokenLogoUrl && !failed) {
    return (
      <img
        className="swap-token-logo"
        src={token.tokenLogoUrl}
        width={size}
        height={size}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  const hue = [...token.tokenSymbol].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  return (
    <span
      className="swap-token-fallback"
      style={{ width: size, height: size, background: `hsl(${hue}, 50%, 92%)`, color: `hsl(${hue}, 55%, 38%)` }}
    >
      {token.tokenSymbol.slice(0, 3).toUpperCase()}
    </span>
  );
}

function TokenPickerModal({
  tokens,
  loading,
  excludeAddress,
  onClose,
  onSelect,
}: {
  tokens: OkxToken[];
  loading: boolean;
  excludeAddress?: string;
  onClose: () => void;
  onSelect: (token: OkxToken) => void;
}) {
  const [query, setQuery] = useState('');
  const exclude = excludeAddress?.toLowerCase();
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = tokens.filter((t) => t.tokenContractAddress.toLowerCase() !== exclude);
    if (!q) return base.slice(0, 200);
    return base
      .filter(
        (t) =>
          t.tokenSymbol.toLowerCase().includes(q) ||
          t.tokenName.toLowerCase().includes(q) ||
          t.tokenContractAddress.toLowerCase() === q,
      )
      .slice(0, 200);
  }, [tokens, query, exclude]);

  return (
    <div className="receive-modal-overlay" onClick={onClose}>
      <div className="okx-picker-panel" onClick={(e) => e.stopPropagation()}>
        <div className="receive-modal-header">
          <span className="receive-modal-title">Select a token</span>
          <button className="receive-modal-close" onClick={onClose}><CloseIcon size={16} /></button>
        </div>
        <div className="okx-picker-search">
          <div className="search-box">
            <span className="search-icon"><SearchIcon size={14} /></span>
            <input
              className="search-input"
              autoFocus
              placeholder="Search name, symbol, or paste address"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="okx-picker-list">
          {loading ? (
            <div className="tp-empty">Loading tokens…</div>
          ) : filtered.length === 0 ? (
            <div className="tp-empty">No tokens found.</div>
          ) : (
            filtered.map((t) => (
              <button key={`${t.tokenContractAddress}`} className="tp-token-row" onClick={() => onSelect(t)}>
                <span className="tp-token-icon-wrap"><TokenMark token={t} size={28} /></span>
                <span className="tp-token-info">
                  <span className="tp-token-symbol">{t.tokenSymbol}</span>
                  <span className="tp-token-sub">
                    <span className="tp-token-name">{t.tokenName}</span>
                    {!okxIsNative(t.tokenContractAddress) && (
                      <span className="tp-token-addr">{shortAddr(t.tokenContractAddress)}</span>
                    )}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
