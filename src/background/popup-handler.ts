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
  serializeTransaction, type TransactionSerializable,
} from 'viem';
import { genId } from '../types/messages';
import type { WhitelistRule } from '../types/whitelist';
import type { Network } from '../types/network';
import { type WalletSettings, DEFAULT_SETTINGS } from '../types/settings';
import { emitAccountsChanged, emitChainChanged } from './events';
import { toHex } from 'viem';
import { applyGasPolicy, clampEstimatedFees } from '../lib/gas';
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
      const hash = await retryWithNextNonce(async (nonceOverride) => {
        const nonce = nonceOverride ?? await publicClient.getTransactionCount({
          address: account.address,
          blockTag: 'pending',
        });
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
      const hash = await retryWithNextNonce(async (nonceOverride) => {
        const nonce = nonceOverride ?? await publicClient.getTransactionCount({
          address: account.address,
          blockTag: 'pending',
        });
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
