import * as keyManager from '../lib/key-manager';
import * as networkManager from '../lib/network-manager';
import * as whitelist from '../lib/whitelist';
import * as tokenManager from '../lib/token-manager';
import * as txLogger from '../lib/tx-logger';
import { getClient } from '../lib/network-manager';
import { handleRpcMethod } from './rpc-handler';
import { getMulticall3Address } from '../lib/multicall';
import { getItem, setItem, STORAGE_KEYS } from '../lib/storage';
import {
  formatEther, formatUnits, parseEther, parseUnits, encodeFunctionData, erc20Abi, hexToBigInt,
  serializeTransaction, createWalletClient, http, parseTransaction, type TransactionSerializable,
} from 'viem';
import { requestUserConfirmation } from './confirm-manager';
import { genId } from '../types/messages';
import type { WhitelistRule } from '../types/whitelist';
import type { Network } from '../types/network';
import { type WalletSettings, DEFAULT_SETTINGS } from '../types/settings';
import { emitAccountsChanged, emitChainChanged } from './events';
import { toHex } from 'viem';
import { applyGasPolicy, clampEstimatedFees, computeReplacementFees } from '../lib/gas';
import { notifyTx } from '../lib/notify';
import { retryWithNextNonce } from '../lib/nonce';
import { openLedgerPickerWindow } from './ledger-picker-manager';

/** Handle actions from the Popup UI. */
export async function handlePopupAction(action: string, payload: any): Promise<unknown> {
  switch (action) {
    // --- Wallet ---
    case 'hasWallet':
      return keyManager.hasWallet();
    case 'isUnlocked':
      return keyManager.isUnlocked();
    case 'createWallet':
      return keyManager.createWallet(payload.password, payload.label);
    case 'importPrivateKey':
      return keyManager.importPrivateKey(payload.privateKey, payload.password, payload.label);
    case 'importMnemonic':
      return keyManager.importMnemonic(payload.mnemonic, payload.password, payload.label);
    case 'unlock':
      return keyManager.unlock(payload.password);
    case 'lock':
      await keyManager.lock();
      emitAccountsChanged([]);
      return true;
    case 'getAddress':
      return await keyManager.getAddress();

    // --- Multi-account ---
    case 'listAccounts':
      return keyManager.listAccounts();
    case 'switchAccount': {
      const newAddr = await keyManager.switchAccount(payload.accountId);
      emitAccountsChanged([newAddr]);
      return newAddr;
    }
    case 'renameAccount':
      return keyManager.renameAccount(payload.accountId, payload.label);
    case 'removeAccount': {
      await keyManager.removeAccount(payload.accountId);
      const addr = await keyManager.getAddress();
      emitAccountsChanged([addr]);
      return true;
    }
    case 'getActiveAccountId':
      return await keyManager.getActiveAccountId();
    case 'getActiveAccountInfo':
      return keyManager.getActiveAccountInfo();
    case 'deleteWallet':
      return keyManager.deleteWallet();
    case 'exportPrivateKey':
      return keyManager.exportPrivateKey(payload.accountId, payload.password);

    // --- Add account (reuses master password) ---
    case 'addAccountGenerate': {
      const addr = await keyManager.addAccountGenerate(payload.label);
      emitAccountsChanged([addr]);
      return addr;
    }
    case 'addAccountPrivateKey': {
      const addr = await keyManager.addAccountPrivateKey(payload.privateKey, payload.label);
      emitAccountsChanged([addr]);
      return addr;
    }
    case 'addAccountMnemonic': {
      const addr = await keyManager.addAccountMnemonic(payload.mnemonic, payload.label);
      emitAccountsChanged([addr]);
      return addr;
    }
    case 'addWatchOnlyAccount': {
      const addr = await keyManager.addWatchOnlyAccount(payload.address, payload.label);
      emitAccountsChanged([addr]);
      return addr;
    }

    // --- Ledger ---
    case 'setupLedgerWallet': {
      const addr = await keyManager.setupLedgerWallet(payload.password, payload.seeds);
      emitAccountsChanged([addr]);
      return addr;
    }
    case 'addLedgerAccounts': {
      const addr = await keyManager.addLedgerAccounts(payload.seeds);
      emitAccountsChanged([addr]);
      return addr;
    }
    case 'pickLedgerAccounts':
      return openLedgerPickerWindow();
    case 'prepareLedgerSendTx':
      return prepareLedgerSendTx(payload);
    case 'broadcastSignedTx':
      return broadcastSignedTx(payload);

    // --- Balance ---
    case 'getNativeBalance': {
      const address = await keyManager.getAddress();
      const client = await getClient();
      const balance = await client.getBalance({ address: address as `0x${string}` });
      return formatEther(balance);
    }
    case 'getAccountNonces': {
      const address = await keyManager.getAddress();
      const client = await getClient();
      const [latest, pending] = await Promise.all([
        client.getTransactionCount({
          address: address as `0x${string}`,
          blockTag: 'latest',
        }),
        client.getTransactionCount({
          address: address as `0x${string}`,
          blockTag: 'pending',
        }),
      ]);
      return { latest, pending };
    }

    // --- Send native token ---
    case 'sendNative': {
      await assertActiveCanSign();
      const account = await keyManager.getAccount();
      const network = await networkManager.getActiveNetwork();
      const publicClient = await getClient(network.chainId);
      const client = await networkManager.getWalletClient(account);
      const chain = networkManager.buildViemChain(network);
      const value = parseEther(payload.amount);
      const fee = applyFeeOverride(payload.fee);
      const finalGas = await resolveGas(
        publicClient,
        fee.txArgs.gas,
        { from: account.address, to: payload.to, value },
      );
      let usedNonce = 0;
      const hash = await retryWithNextNonce(async (nonceOverride) => {
        const nonce = nonceOverride ?? await publicClient.getTransactionCount({
          address: account.address,
          blockTag: 'pending',
        });
        usedNonce = nonce;
        return client.sendTransaction({
          to: payload.to as `0x${string}`,
          value,
          chain,
          ...fee.txArgs,
          gas: finalGas,
          nonce,
        } as any);
      });
      const logId = genId();
      await txLogger.appendLog({
        id: logId,
        timestamp: Date.now(),
        chainId: network.chainId,
        from: account.address,
        to: payload.to,
        value: String(value),
        hash,
        origin: 'Auto Wallet',
        autoSigned: false,
        status: 'pending',
        nonce: usedNonce,
        ...fee.logFields,
        gasLimit: finalGas.toString(),
      });
      pollTxReceipt(logId, network.chainId, hash, 'Auto Wallet', false, network.blockExplorerUrl);
      return hash;
    }

    // --- Send ERC-20 token ---
    case 'sendToken': {
      await assertActiveCanSign();
      const account = await keyManager.getAccount();
      const network = await networkManager.getActiveNetwork();
      const publicClient = await getClient(network.chainId);
      const client = await networkManager.getWalletClient(account);
      const chain = networkManager.buildViemChain(network);
      const amount = parseUnits(payload.amount, payload.decimals);
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [payload.to as `0x${string}`, amount],
      });
      const fee = applyFeeOverride(payload.fee);
      const finalGas = await resolveGas(
        publicClient,
        fee.txArgs.gas,
        { from: account.address, to: payload.tokenAddress, data, value: 0n },
      );
      let usedNonce = 0;
      const hash = await retryWithNextNonce(async (nonceOverride) => {
        const nonce = nonceOverride ?? await publicClient.getTransactionCount({
          address: account.address,
          blockTag: 'pending',
        });
        usedNonce = nonce;
        return client.sendTransaction({
          to: payload.tokenAddress as `0x${string}`,
          data,
          value: 0n,
          chain,
          ...fee.txArgs,
          gas: finalGas,
          nonce,
        } as any);
      });
      const logId = genId();
      await txLogger.appendLog({
        id: logId,
        timestamp: Date.now(),
        chainId: network.chainId,
        from: account.address,
        to: payload.to,
        value: String(amount),
        hash,
        method: data.slice(0, 10),
        origin: 'Auto Wallet',
        autoSigned: false,
        status: 'pending',
        nonce: usedNonce,
        ...fee.logFields,
        gasLimit: finalGas.toString(),
      });
      pollTxReceipt(logId, network.chainId, hash, 'Auto Wallet', false, network.blockExplorerUrl);
      return hash;
    }

    // --- Networks ---
    case 'getNetworks':
      return networkManager.getAllNetworks();
    case 'getActiveNetwork':
      return networkManager.getActiveNetwork();
    case 'switchNetwork': {
      const net = await networkManager.switchNetwork(payload.chainId);
      emitChainChanged(toHex(net.chainId));
      return net;
    }
    case 'addCustomNetwork':
      return networkManager.addCustomNetwork(payload as Network);
    case 'updateNetwork':
      return networkManager.updateNetwork(payload as Network);
    case 'removeCustomNetwork':
      return networkManager.removeCustomNetwork(payload.chainId);
    case 'getStarredNetworks': {
      return (await getItem<number[]>(STORAGE_KEYS.STARRED_NETWORKS)) ?? [];
    }
    case 'setStarredNetworks': {
      const next = (payload.chainIds as number[]) ?? [];
      await setItem(STORAGE_KEYS.STARRED_NETWORKS, next);
      return next;
    }

    // --- Whitelist ---
    case 'getRules':
      return whitelist.getRules();
    case 'addRule':
      return whitelist.addRule(payload as WhitelistRule);
    case 'updateRule':
      return whitelist.updateRule(payload.id, payload.patch);
    case 'removeRule':
      return whitelist.removeRule(payload.id);

    // --- Tokens ---
    case 'getTokens':
      return tokenManager.getTokens();
    case 'addToken':
      return tokenManager.addToken(payload.chainId, payload.address);
    case 'removeToken':
      return tokenManager.removeToken(payload.chainId, payload.address);
    case 'getTokenBalance':
      return tokenManager.getTokenBalance(payload.token, await keyManager.getAddress());
    case 'getApprovalTokenInfo': {
      const chainId = Number(payload.chainId);
      const tokenAddress = payload.tokenAddress as `0x${string}`;
      const owner = payload.owner as `0x${string}`;
      const client = await getClient(chainId);
      const [symbol, decimals, name, rawBalance] = await Promise.all([
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'name' }).catch(() => undefined),
        client.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner],
        }),
      ]);
      const normalizedDecimals = Number(decimals);
      return {
        symbol: String(symbol),
        decimals: normalizedDecimals,
        name: name ? String(name) : undefined,
        balanceRaw: (rawBalance as bigint).toString(),
        balance: formatUnits(rawBalance as bigint, normalizedDecimals),
      };
    }

    // --- Fee suggestions for the confirm popup ---
    case 'getFeeSuggestions':
      return getFeeSuggestions(payload ?? {});

    // --- Tx Log ---
    case 'getTxLog':
      return txLogger.getLog();
    case 'clearTxLog':
      return txLogger.clearLog();
    case 'speedUpTx':
      return replacePendingTx(payload.logId, 'speedup');
    case 'cancelTx':
      return replacePendingTx(payload.logId, 'cancel');

    // --- Swap (XFlows) ---
    case 'getStarredSwapChains': {
      return (await getItem<number[]>(STORAGE_KEYS.SWAP_STARRED_CHAINS)) ?? [];
    }
    case 'setStarredSwapChains': {
      const next = (payload.chainIds as number[]) ?? [];
      await setItem(STORAGE_KEYS.SWAP_STARRED_CHAINS, next);
      return next;
    }
    /**
     * Read a token balance on an arbitrary chain (not necessarily the active
     * one). Used by the Swap page where the source chain may differ from the
     * currently selected wallet chain. `tokenAddress` of zero means native.
     */
    case 'getBalanceForChain': {
      const chainId = Number(payload.chainId);
      const tokenAddress = payload.tokenAddress as string;
      const owner = payload.owner as `0x${string}`;
      const client = await getClient(chainId);
      if (/^0x0+$/.test(tokenAddress)) {
        const raw = await client.getBalance({ address: owner });
        return { decimals: 18, balanceRaw: raw.toString(), balance: formatEther(raw) };
      }
      const [decimals, rawBalance] = await Promise.all([
        client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
        client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner],
        }),
      ]);
      const d = Number(decimals);
      return {
        decimals: d,
        balanceRaw: (rawBalance as bigint).toString(),
        balance: formatUnits(rawBalance as bigint, d),
      };
    }
    /**
     * Batched balance lookup: one multicall3 round-trip for ERC20s + one
     * `getBalance` for native (if requested), instead of N sequential reads.
     * Used by the Swap token picker so balances for ~50 tokens land in a
     * single network call.
     *
     * Falls back to parallel per-token reads on chains where we don't have a
     * known multicall3 deployment.
     */
    case 'getBalancesBatch': {
      const chainId = Number(payload.chainId);
      const owner = payload.owner as `0x${string}`;
      const tokens = payload.tokens as Array<{ address: string; decimals: number }>;
      const client = await getClient(chainId);
      const multicallAddress = getMulticall3Address(chainId);

      const isNative = (a: string) => /^0x0+$/.test(a);
      const nativeReq = tokens.find((t) => isNative(t.address));
      const erc20Reqs = tokens.filter((t) => !isNative(t.address));

      // Native balance is always a single eth_call — multicall doesn't help.
      const nativePromise = nativeReq
        ? client.getBalance({ address: owner }).then((raw) => ({
            address: nativeReq.address,
            balanceRaw: raw.toString(),
            balance: formatEther(raw),
          }))
        : null;

      let erc20Results: Array<{ address: string; balanceRaw: string; balance: string }> = [];
      if (erc20Reqs.length > 0) {
        if (multicallAddress) {
          const calls = erc20Reqs.map((t) => ({
            address: t.address as `0x${string}`,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [owner],
          }));
          const raws = await client.multicall({
            contracts: calls,
            multicallAddress,
            allowFailure: true,
          });
          erc20Results = erc20Reqs.map((t, i) => {
            const r = raws[i];
            const raw = r && r.status === 'success' ? (r.result as bigint) : 0n;
            return {
              address: t.address,
              balanceRaw: raw.toString(),
              balance: formatUnits(raw, t.decimals),
            };
          });
        } else {
          // No multicall3 deployment we trust — fan out in parallel.
          erc20Results = await Promise.all(erc20Reqs.map(async (t) => {
            try {
              const raw = await client.readContract({
                address: t.address as `0x${string}`,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [owner],
              }) as bigint;
              return { address: t.address, balanceRaw: raw.toString(), balance: formatUnits(raw, t.decimals) };
            } catch {
              return { address: t.address, balanceRaw: '0', balance: '0' };
            }
          }));
        }
      }

      const native = nativePromise ? await nativePromise : null;
      return native ? [native, ...erc20Results] : erc20Results;
    }
    case 'getErc20Allowance': {
      const chainId = Number(payload.chainId);
      const tokenAddress = payload.tokenAddress as `0x${string}`;
      const owner = payload.owner as `0x${string}`;
      const spender = payload.spender as `0x${string}`;
      const client = await getClient(chainId);
      const allowance = await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
      });
      return (allowance as bigint).toString();
    }
    /**
     * Submit a transaction through the standard confirm popup. Reused by the
     * Swap page for ERC20 approve and XFlows buildTx calls. Looks identical to a
     * dApp's `eth_sendTransaction` to the user — including simulation, fee
     * editing, and Ledger signing — except the origin label.
     *
     * Switches the wallet's active chain to `chainId` first so the tx is
     * sent on the right network. `handleSendTransaction` reads the active
     * chain to derive the RPC client.
     */
    case 'submitTxViaConfirm': {
      const tx = payload.tx as Record<string, string>;
      const origin = (payload.origin as string) ?? 'Auto Wallet Swap';
      if (payload.chainId !== undefined && payload.chainId !== null) {
        const targetChainId = Number(payload.chainId);
        const current = await networkManager.getActiveChainId();
        if (current !== targetChainId) {
          const switched = await networkManager.switchNetwork(targetChainId);
          emitChainChanged(toHex(switched.chainId));
        }
      }
      const sender: chrome.runtime.MessageSender = {
        id: chrome.runtime.id,
        url: chrome.runtime.getURL('swap.html'),
      };
      return handleRpcMethod('eth_sendTransaction', [tx], origin, sender);
    }

    // --- Settings ---
    case 'getSettings': {
      const s = await getItem<WalletSettings>(STORAGE_KEYS.SETTINGS);
      return { ...DEFAULT_SETTINGS, ...s };
    }
    case 'saveSettings': {
      const current = await getItem<WalletSettings>(STORAGE_KEYS.SETTINGS);
      const merged = { ...DEFAULT_SETTINGS, ...current, ...payload };
      await setItem(STORAGE_KEYS.SETTINGS, merged);
      return merged;
    }

    default:
      throw new Error(`Unknown popup action: ${action}`);
  }
}

/**
 * Reject internal popup actions that mutate chain state when the active account
 * has no signing material. Mirrors the rpc-handler guard so a buggy popup
 * (e.g. a forgotten button) can't slip past the UI hide.
 */
async function assertActiveCanSign(): Promise<void> {
  const info = await keyManager.getActiveAccountInfo();
  if (info.type === 'watchOnly') {
    throw new Error('Active account is watch-only — it cannot sign transactions');
  }
}

// --- Fee override application ---

interface FeeOverrideInput {
  type: 'eip1559' | 'legacy';
  gas: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  gasPrice: string | null;
}

function applyFeeOverride(fee: FeeOverrideInput | null | undefined): {
  txArgs: Record<string, bigint>;
  logFields: Partial<txLogger.TxLogEntry>;
} {
  if (!fee) return { txArgs: {}, logFields: {} };
  const txArgs: Record<string, bigint> = {};
  const logFields: Partial<txLogger.TxLogEntry> = {};

  if (fee.gas) {
    const gas = BigInt(fee.gas);
    txArgs.gas = gas;
    logFields.gasLimit = gas.toString();
  }
  if (fee.type === 'eip1559') {
    if (fee.maxFeePerGas) {
      const v = BigInt(fee.maxFeePerGas);
      txArgs.maxFeePerGas = v;
      logFields.maxFeePerGas = v.toString();
    }
    if (fee.maxPriorityFeePerGas) {
      const v = BigInt(fee.maxPriorityFeePerGas);
      txArgs.maxPriorityFeePerGas = v;
      logFields.maxPriorityFeePerGas = v.toString();
    }
  } else if (fee.gasPrice) {
    const v = BigInt(fee.gasPrice);
    txArgs.gasPrice = v;
    logFields.gasPrice = v.toString();
  }
  return { txArgs, logFields };
}

// --- Fee suggestions for the confirm popup ---

interface FeeSuggestionsRequest {
  to?: string;
  from?: string;
  data?: string;
  value?: string;
}

export interface FeeSuggestions {
  chainId: number;
  symbol: string;
  decimals: number;
  type: 'eip1559' | 'legacy';
  gasEstimate: string | null;          // gas units, decimal
  baseFeePerGas: string | null;        // wei, decimal
  maxFeePerGas: string | null;         // wei, decimal — suggested
  maxPriorityFeePerGas: string | null; // wei, decimal — suggested
  gasPrice: string | null;             // wei, decimal — suggested (legacy only)
}

async function getFeeSuggestions(req: FeeSuggestionsRequest): Promise<FeeSuggestions> {
  const network = await networkManager.getActiveNetwork();
  const client = await getClient(network.chainId);

  let baseFee: bigint | null = null;
  let maxFee: bigint | null = null;
  let priority: bigint | null = null;
  let gasPrice: bigint | null = null;
  let type: 'eip1559' | 'legacy' = 'legacy';

  // Detect EIP-1559 by reading baseFeePerGas on the latest block
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.baseFeePerGas !== undefined && block.baseFeePerGas !== null) {
      baseFee = block.baseFeePerGas;
      type = 'eip1559';
      const fees = await client.estimateFeesPerGas();
      if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
        const clamped = clampEstimatedFees({
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        maxFee = clamped.maxFeePerGas;
        priority = clamped.maxPriorityFeePerGas;
      } else {
        maxFee = fees.maxFeePerGas ?? null;
        priority = fees.maxPriorityFeePerGas ?? null;
      }
    }
  } catch {
    // ignore — fall through to legacy
  }

  if (type === 'legacy') {
    try {
      gasPrice = await client.getGasPrice();
    } catch {
      gasPrice = null;
    }
  }

  // Estimate gas if we have enough info, then apply the same ×1.2 buffer the
  // send path would apply when no explicit gas is supplied. Returning the
  // buffered value here is load-bearing: FeeEditor auto-fills its gas input
  // with this value and feeds it back as `feeOverride.gas`. The send path
  // then trusts caller-provided gas verbatim (see resolveGas / resolveTxGas),
  // so if we returned the raw estimate the 1.2x buffer would be silently
  // dropped on every confirm-popup tx.
  let gasEstimate: bigint | null = null;
  if (req.to || req.data) {
    try {
      const fromAddr = req.from ?? (await keyManager.getAddress());
      gasEstimate = await applyGasPolicy(null, () => client.estimateGas({
        account: fromAddr as `0x${string}`,
        to: req.to as `0x${string}` | undefined,
        data: (req.data as `0x${string}`) ?? undefined,
        value: req.value ? hexToBigInt(req.value as `0x${string}`) : 0n,
      }));
    } catch {
      gasEstimate = null;
    }
  }

  return {
    chainId: network.chainId,
    symbol: network.symbol,
    decimals: network.decimals,
    type,
    gasEstimate: gasEstimate?.toString() ?? null,
    baseFeePerGas: baseFee?.toString() ?? null,
    maxFeePerGas: maxFee?.toString() ?? null,
    maxPriorityFeePerGas: priority?.toString() ?? null,
    gasPrice: gasPrice?.toString() ?? null,
  };
}

// --- Speed up / cancel a pending transaction ---

/**
 * Read the network's current fee suggestion for an arbitrary chain. Mirrors the
 * EIP-1559-vs-legacy detection in getFeeSuggestions but is parameterized by
 * client so it works for the pending tx's chain (not just the active one).
 */
async function getChainFeeData(client: Awaited<ReturnType<typeof getClient>>): Promise<{
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
}> {
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.baseFeePerGas !== undefined && block.baseFeePerGas !== null) {
      const fees = await client.estimateFeesPerGas();
      if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
        const clamped = clampEstimatedFees({
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        return { maxFeePerGas: clamped.maxFeePerGas, maxPriorityFeePerGas: clamped.maxPriorityFeePerGas, gasPrice: null };
      }
    }
  } catch {
    // fall through to legacy gas price
  }
  try {
    return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: await client.getGasPrice() };
  } catch {
    return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: null };
  }
}

/**
 * Re-broadcast a pending transaction at the same nonce with higher gas.
 *  - 'speedup' keeps the original to/value/data so the same action just lands
 *    faster.
 *  - 'cancel' sends a 0-value self-transfer, which voids the stuck tx once it
 *    mines (only one tx per nonce can confirm).
 *
 * The original tx is pulled live from the node so we have its exact nonce,
 * calldata, and the fees we must beat; if it already mined we refuse. The
 * existing history entry is updated in place (new hash + fees) and receipt
 * polling restarts on the replacement.
 */
/** Reject a slow network read so the UI gets a clear error instead of hanging. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s — check the network's RPC`)), ms),
    ),
  ]);
}

async function replacePendingTx(logId: string, kind: 'speedup' | 'cancel'): Promise<{ hash: string }> {
  console.log(`[Auto-Wallet] replacePendingTx start`, { logId, kind });
  await assertActiveCanSign();

  const entry = (await txLogger.getLog()).find((e) => e.id === logId);
  if (!entry) throw new Error('Transaction not found in history');
  if (entry.status !== 'pending') throw new Error('Only pending transactions can be sped up or cancelled');
  if (!entry.hash) throw new Error('Transaction has not been broadcast yet');

  // Software keys sign in the background; Ledger signs on-device via the confirm
  // popup. Use the active account's *address* for the ownership check so we don't
  // call getAccount() (which throws) on the Ledger path.
  const info = await keyManager.getActiveAccountInfo();
  if (info.address.toLowerCase() !== entry.from.toLowerCase()) {
    throw new Error(
      `This transaction was sent from ${entry.from.slice(0, 8)}…, but the active account is ${info.address.slice(0, 8)}… — switch to the sending account first`,
    );
  }
  if (info.type === 'ledger' && !info.derivationPath) {
    throw new Error('Ledger account is missing its derivation path');
  }

  const network = (await networkManager.getAllNetworks()).find((n) => n.chainId === entry.chainId);
  if (!network) throw new Error(`Network ${entry.chainId} is not configured`);
  const publicClient = await getClient(entry.chainId);

  console.log(`[Auto-Wallet] replacePendingTx: fetching original tx ${entry.hash} on chain ${entry.chainId}`);
  let original;
  try {
    original = await withTimeout(
      publicClient.getTransaction({ hash: entry.hash as `0x${string}` }),
      15_000,
      'Fetching the original transaction',
    );
  } catch (err: any) {
    if (err?.message?.includes('timed out')) throw err;
    throw new Error('Original transaction not found on the node — it may have already dropped from the mempool');
  }
  console.log(`[Auto-Wallet] replacePendingTx: got original`, {
    nonce: original.nonce,
    blockNumber: original.blockNumber,
    maxFeePerGas: original.maxFeePerGas?.toString(),
    gasPrice: original.gasPrice?.toString(),
  });
  if (original.blockNumber !== null) {
    throw new Error('Transaction already confirmed — it can no longer be sped up or cancelled');
  }
  if (kind === 'speedup' && !original.to) {
    throw new Error('Cannot speed up a contract-creation transaction');
  }

  const networkFees = await getChainFeeData(publicClient);
  const bumped = computeReplacementFees(
    {
      maxFeePerGas: original.maxFeePerGas ?? null,
      maxPriorityFeePerGas: original.maxPriorityFeePerGas ?? null,
      gasPrice: original.gasPrice ?? null,
    },
    networkFees,
  );

  // Replacement payload, shared by both signing paths.
  const to = (kind === 'speedup' ? original.to! : info.address) as `0x${string}`;
  const value = kind === 'speedup' ? original.value : 0n;
  const data = kind === 'speedup' && original.input && original.input !== '0x'
    ? (original.input as `0x${string}`)
    : undefined;
  const gas = kind === 'speedup' ? original.gas : 21_000n; // 21000 = bare no-data transfer

  console.log(`[Auto-Wallet] replacePendingTx: sending replacement (${info.type})`, {
    nonce: original.nonce, to, type: bumped.type,
    maxFeePerGas: bumped.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: bumped.maxPriorityFeePerGas?.toString(),
    gasPrice: bumped.gasPrice?.toString(),
  });

  let hash: `0x${string}`;
  // Actual fees recorded in the log — the bumped values for software, or the
  // real signed values for Ledger (the user may have edited them in the popup).
  let logGas = gas;
  let logMaxFee = bumped.maxFeePerGas ?? null;
  let logPriority = bumped.maxPriorityFeePerGas ?? null;
  let logGasPrice = bumped.gasPrice ?? null;

  if (info.type === 'ledger') {
    // On-device signing: hand a fully-prepared tx to the confirm popup, which
    // talks to the Ledger over WebHID and returns the signed raw bytes.
    const txJson = {
      type: bumped.type,
      to,
      value: value.toString(),
      data,
      gas: gas.toString(),
      nonce: original.nonce,
      chainId: entry.chainId,
      maxFeePerGas: bumped.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: bumped.maxPriorityFeePerGas?.toString(),
      gasPrice: bumped.gasPrice?.toString(),
    };
    const toHexOrUndef = (v: bigint | undefined) => (v !== undefined ? toHex(v) : undefined);
    const displayTx: Record<string, string | undefined> = {
      from: info.address,
      to,
      value: toHex(value),
      data,
      gas: toHex(gas),
      nonce: toHex(original.nonce),
      maxFeePerGas: toHexOrUndef(bumped.maxFeePerGas),
      maxPriorityFeePerGas: toHexOrUndef(bumped.maxPriorityFeePerGas),
      gasPrice: toHexOrUndef(bumped.gasPrice),
    };
    const { approved, signedRawTx } = await requestUserConfirmation({
      id: genId(),
      method: 'eth_sendTransaction',
      origin: `${entry.origin} · ${kind === 'cancel' ? 'Cancel' : 'Speed Up'}`,
      params: [displayTx],
      signerAddress: info.address,
      chainId: entry.chainId,
      chainName: network.name,
      nativeSymbol: network.symbol,
      ledger: { derivationPath: info.derivationPath!, txJson },
    });
    if (!approved) throw new Error('Ledger signing was rejected');
    if (!signedRawTx) throw new Error('Ledger did not return a signed transaction');
    hash = await withTimeout(
      publicClient.sendRawTransaction({ serializedTransaction: signedRawTx }),
      25_000,
      'Broadcasting the replacement',
    );
    // The popup may have edited fees before signing — read the truth back out.
    try {
      const signed = parseTransaction(signedRawTx);
      logGas = signed.gas ?? gas;
      logMaxFee = signed.maxFeePerGas ?? null;
      logPriority = signed.maxPriorityFeePerGas ?? null;
      logGasPrice = signed.gasPrice ?? null;
    } catch {
      // keep the prepared values if the raw tx can't be parsed
    }
  } else {
    const account = await keyManager.getAccount();
    const txArgs: any = { nonce: original.nonce, chain: networkManager.buildViemChain(network), to, value, data, gas };
    if (bumped.type === 'eip1559') {
      txArgs.maxFeePerGas = bumped.maxFeePerGas;
      txArgs.maxPriorityFeePerGas = bumped.maxPriorityFeePerGas;
    } else {
      txArgs.gasPrice = bumped.gasPrice;
    }
    const client = createWalletClient({ account, transport: http(network.rpcUrl, { timeout: 20_000, retryCount: 1 }) });
    hash = await withTimeout(client.sendTransaction(txArgs), 25_000, 'Broadcasting the replacement');
  }
  console.log(`[Auto-Wallet] replacePendingTx: broadcast ok`, { hash });

  // Update the same row in place so History shows one entry that's now faster
  // (or being cancelled). Keep the original to/value/method so the user still
  // sees what the tx was doing; `prevHash` retains the superseded hash for
  // cross-referencing, while `hash` becomes the new (trackable) replacement.
  await txLogger.updateLogEntry(logId, {
    hash,
    prevHash: entry.hash,
    nonce: original.nonce,
    // A cancel always wins the label; a speed-up after a cancel keeps 'cancel'.
    replacementKind: kind === 'cancel' ? 'cancel' : (entry.replacementKind ?? 'speedup'),
    gasLimit: logGas.toString(),
    maxFeePerGas: logMaxFee?.toString(),
    maxPriorityFeePerGas: logPriority?.toString(),
    gasPrice: logGasPrice?.toString(),
    // Clear stale actuals from the prior (now-replaced) hash.
    gasUsed: undefined,
    effectiveGasPrice: undefined,
    feeWei: undefined,
  });

  pollTxReceipt(logId, entry.chainId, hash, entry.origin, entry.autoSigned, network.blockExplorerUrl);
  return { hash };
}

// --- Ledger send-tx preparation & raw broadcast ---

interface LedgerPrepArgs {
  kind: 'native' | 'token';
  to: string;
  amount: string;
  tokenAddress?: string;
  decimals?: number;
  fee: FeeOverrideInput | null;
}

interface SerializedTxJSON {
  type: 'eip1559' | 'legacy';
  to: `0x${string}`;
  value: string;
  data?: `0x${string}`;
  gas: string;
  nonce: number;
  chainId: number;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

async function prepareLedgerSendTx(args: LedgerPrepArgs): Promise<{ unsignedHex: string; txJson: SerializedTxJSON }> {
  const info = await keyManager.getActiveAccountInfo();
  if (info.type !== 'ledger') throw new Error('Active account is not a Ledger account');

  const network = await networkManager.getActiveNetwork();
  const publicClient = await getClient(network.chainId);

  let txTo: `0x${string}`;
  let value: bigint;
  let data: `0x${string}` | undefined;
  if (args.kind === 'native') {
    txTo = args.to as `0x${string}`;
    value = parseEther(args.amount);
    data = undefined;
  } else {
    if (!args.tokenAddress || args.decimals === undefined) {
      throw new Error('Token send requires tokenAddress and decimals');
    }
    txTo = args.tokenAddress as `0x${string}`;
    value = 0n;
    const amt = parseUnits(args.amount, args.decimals);
    data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [args.to as `0x${string}`, amt],
    });
  }

  const feeApplied = applyFeeOverride(args.fee);
  const gas = await resolveGas(publicClient, feeApplied.txArgs.gas, {
    from: info.address, to: txTo, data, value,
  });

  const nonce = await publicClient.getTransactionCount({
    address: info.address as `0x${string}`,
    blockTag: 'pending',
  });

  // Decide between EIP-1559 and legacy. User override > chain auto-detect.
  let type: 'eip1559' | 'legacy';
  let maxFeePerGas: bigint | undefined;
  let maxPriorityFeePerGas: bigint | undefined;
  let gasPrice: bigint | undefined;

  if (feeApplied.txArgs.maxFeePerGas) {
    type = 'eip1559';
    maxFeePerGas = feeApplied.txArgs.maxFeePerGas;
    maxPriorityFeePerGas = feeApplied.txArgs.maxPriorityFeePerGas ?? maxFeePerGas;
  } else if (feeApplied.txArgs.gasPrice) {
    type = 'legacy';
    gasPrice = feeApplied.txArgs.gasPrice;
  } else {
    try {
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      if (block.baseFeePerGas !== null && block.baseFeePerGas !== undefined) {
        const fees = await publicClient.estimateFeesPerGas();
        const clamped = clampEstimatedFees({
          maxFeePerGas: fees.maxFeePerGas!,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
        });
        type = 'eip1559';
        maxFeePerGas = clamped.maxFeePerGas;
        maxPriorityFeePerGas = clamped.maxPriorityFeePerGas;
      } else {
        type = 'legacy';
        gasPrice = await publicClient.getGasPrice();
      }
    } catch {
      type = 'legacy';
      gasPrice = await publicClient.getGasPrice();
    }
  }

  const txObject: TransactionSerializable = type === 'eip1559'
    ? {
        type: 'eip1559',
        chainId: network.chainId,
        nonce,
        to: txTo,
        value,
        data,
        gas,
        maxFeePerGas: maxFeePerGas!,
        maxPriorityFeePerGas: maxPriorityFeePerGas!,
      }
    : {
        type: 'legacy',
        chainId: network.chainId,
        nonce,
        to: txTo,
        value,
        data,
        gas,
        gasPrice: gasPrice!,
      };

  const unsignedHexWithPrefix = serializeTransaction(txObject);
  const unsignedHex = unsignedHexWithPrefix.startsWith('0x')
    ? unsignedHexWithPrefix.slice(2)
    : unsignedHexWithPrefix;

  const txJson: SerializedTxJSON = {
    type,
    to: txTo,
    value: value.toString(),
    data,
    gas: gas.toString(),
    nonce,
    chainId: network.chainId,
    maxFeePerGas: maxFeePerGas?.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(),
    gasPrice: gasPrice?.toString(),
  };

  return { unsignedHex, txJson };
}

interface BroadcastArgs {
  rawTx: `0x${string}`;
  meta: {
    to: string;
    value: string;
    data?: string;
    chainId: number;
    origin?: string;
    autoSigned?: boolean;
    methodSelector?: string;
    gasLimit?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    gasPrice?: string;
  };
}

async function broadcastSignedTx({ rawTx, meta }: BroadcastArgs): Promise<{ hash: string }> {
  const info = await keyManager.getActiveAccountInfo();
  const network = await networkManager.getActiveNetwork();
  const publicClient = await getClient(meta.chainId ?? network.chainId);

  const hash = await publicClient.sendRawTransaction({ serializedTransaction: rawTx });

  const logId = genId();
  await txLogger.appendLog({
    id: logId,
    timestamp: Date.now(),
    chainId: meta.chainId ?? network.chainId,
    from: info.address,
    to: meta.to,
    value: meta.value,
    hash,
    method: meta.methodSelector,
    origin: meta.origin ?? 'Auto Wallet',
    autoSigned: !!meta.autoSigned,
    status: 'pending',
    gasLimit: meta.gasLimit,
    maxFeePerGas: meta.maxFeePerGas,
    maxPriorityFeePerGas: meta.maxPriorityFeePerGas,
    gasPrice: meta.gasPrice,
  });

  pollTxReceipt(
    logId,
    meta.chainId ?? network.chainId,
    hash,
    meta.origin ?? 'Auto Wallet',
    !!meta.autoSigned,
    network.blockExplorerUrl,
  );

  return { hash };
}

// Resolve a gas limit per the wallet's gas policy (see applyGasPolicy in
// lib/gas): caller-supplied values are trusted verbatim, fresh estimates get
// the ×1.2 buffer.
async function resolveGas(
  client: Awaited<ReturnType<typeof getClient>>,
  providedGas: bigint | undefined,
  call: { from: string; to: string; data?: `0x${string}`; value: bigint },
): Promise<bigint> {
  return applyGasPolicy(providedGas, () => client.estimateGas({
    account: call.from as `0x${string}`,
    to: call.to as `0x${string}`,
    data: call.data,
    value: call.value,
  }));
}

// --- Tx receipt polling (shared with rpc-handler, but kept simple as a local helper) ---

function pollTxReceipt(
  logId: string,
  chainId: number,
  hash: string,
  origin: string,
  autoSigned: boolean,
  explorerUrl?: string,
): void {
  const MAX_ATTEMPTS = 60;
  const INTERVAL_MS = 5000;
  let attempts = 0;

  const timer = setInterval(async () => {
    attempts++;
    try {
      const client = await networkManager.getClient(chainId);
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      if (receipt) {
        const status = receipt.status === 'success' ? 'confirmed' : 'failed';
        const gasUsed = receipt.gasUsed;
        const effectiveGasPrice = receipt.effectiveGasPrice;
        const fee = gasUsed !== undefined && effectiveGasPrice !== undefined
          ? gasUsed * effectiveGasPrice
          : null;
        await txLogger.updateLogEntry(logId, {
          status,
          gasUsed: gasUsed?.toString(),
          effectiveGasPrice: effectiveGasPrice?.toString(),
          feeWei: fee?.toString(),
        });
        notifyTx(hash, origin, autoSigned, status, explorerUrl);
        clearInterval(timer);
      }
    } catch {
      // Receipt not available yet — keep polling
    }
    if (attempts >= MAX_ATTEMPTS) {
      clearInterval(timer);
    }
  }, INTERVAL_MS);
}
