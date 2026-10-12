import {
  toHex,
  hexToBigInt,
  serializeTransaction,
  parseTransaction,
  hashDomain,
  hashStruct,
  getTypesForEIP712Domain,
  type TypedDataDomain,
  type TransactionSerializable,
  type PublicClient,
} from 'viem';
import * as keyManager from '../lib/key-manager';
import * as networkManager from '../lib/network-manager';
import * as whitelist from '../lib/whitelist';
import * as txLogger from '../lib/tx-logger';
import * as tokenManager from '../lib/token-manager';
import { genId } from '../types/messages';
import {
  requestUserConfirmation,
  type FeeOverride,
  type SerializedTxJSON,
  type LedgerConfirmContext,
} from './confirm-manager';
import { requestUnlock } from './unlock-manager';
import { notifySign } from '../lib/notify';
import { pollTxReceipt } from './tx-poller';
import { emitAccountsChanged, emitChainChanged } from './events';
import { RpcError, userRejection } from '../lib/rpc-error';
import {
  validateSigner,
  validateRpcUrl,
  parseAddChainParams,
  parseSwitchChainParams,
  parseTxParams,
} from '../lib/rpc-validation';
import {
  parseTypedDataRequest,
  assertTypedDataChain,
  parseWatchAssetParams,
  isForegroundTab,
} from '../lib/rpc-methods.core';
import { isExtensionPageSender } from '../lib/sender-trust';
import { isSiteConnected, connectSite, disconnectSite, getConnectedSites, siteOrigin } from '../lib/connected-sites';
import { applyGasPolicy, clampEstimatedFees } from '../lib/gas';
import { simulateTx, type SimulationPreview } from './bcs-simulation';
import { preparePersonalSignParams, signPreparedPersonalMessage } from '../lib/signing';
import { parseNonceInput, sendWithNonce } from '../lib/nonce';

// --- Rate limiting for eth_requestAccounts ---
let lastUnlockPromptTime = 0;
const UNLOCK_PROMPT_COOLDOWN_MS = 3000; // 3 seconds between unlock popups

// --- RPC Method Router ---

/** Methods a site may only call after the user connected it (eth_requestAccounts). */
const NEEDS_CONNECTION = new Set([
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
]);

/** EIP-1193 4100: the site has not been authorized. */
function unauthorized(): RpcError {
  return new RpcError('This site is not connected to Auto Wallet. Call eth_requestAccounts first.', 4100);
}

export async function handleRpcMethod(
  method: string,
  params: unknown[],
  origin: string,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  // Calls from our own pages (e.g. the Swap page via submitTxViaConfirm) carry
  // a display label as origin, not a site, and need no site connection.
  const internal = isExtensionPageSender(sender, chrome.runtime.id);

  if (method === 'eth_sign') {
    throw new RpcError(
      'eth_sign is disabled: it signs a raw hash the user cannot read. Use personal_sign or eth_signTypedData_v4.',
      4200,
    );
  }
  if (!internal && NEEDS_CONNECTION.has(method) && !(await isSiteConnected(origin))) {
    throw unauthorized();
  }

  switch (method) {
    // --- Account methods ---
    case 'eth_requestAccounts':
      return handleRequestAccounts(origin, internal);
    case 'eth_accounts':
      return handleAccounts(origin, internal);

    // --- Permissions (EIP-2255) ---
    case 'wallet_requestPermissions':
      return handleRequestPermissions(params, origin, internal);
    case 'wallet_getPermissions':
      return handleGetPermissions(origin, internal);
    case 'wallet_revokePermissions':
      return handleRevokePermissions(origin);

    // --- Chain methods ---
    case 'eth_chainId':
      return toHex(await networkManager.getActiveChainId());

    case 'net_version':
      return String(await networkManager.getActiveChainId());

    case 'wallet_switchEthereumChain':
      return handleSwitchChain(params, sender, internal);

    case 'wallet_addEthereumChain':
      return handleAddChain(params, origin, sender, internal);

    // --- Signing ---
    case 'eth_sendTransaction':
      return handleSendTransaction(params, origin);

    case 'personal_sign':
      return handlePersonalSign(params, origin);

    case 'eth_signTypedData_v4':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData':
      return handleSignTypedData(method, params, origin);

    // --- Token ---
    case 'wallet_watchAsset':
      return handleWatchAsset(params, origin);

    // --- Read-only RPC: forward to node ---
    default:
      return forwardToNode(method, params);
  }
}

// --- Handlers ---

async function handleAccounts(origin: string, internal: boolean): Promise<string[]> {
  if (!(await keyManager.isUnlocked())) return [];
  if (!internal && !(await isSiteConnected(origin))) return [];
  return [await keyManager.getAddress()];
}

async function getLedgerContextOrNull(): Promise<{ address: string; derivationPath: string } | null> {
  const info = await keyManager.getActiveAccountInfo();
  if (info.type !== 'ledger') return null;
  if (!info.derivationPath) throw new Error('Ledger account is missing derivation path');
  return { address: info.address, derivationPath: info.derivationPath };
}

/**
 * Reject signing-class RPCs when the active account is watch-only. Throws an
 * EIP-1193 user-rejection so dApps see a clean error instead of a low-level
 * "wallet locked" message.
 */
async function assertActiveAccountCanSign(): Promise<void> {
  const info = await keyManager.getActiveAccountInfo();
  if (info.type === 'watchOnly') {
    throw userRejection('Active account is watch-only — it cannot sign transactions or messages');
  }
}

async function handleRequestAccounts(origin: string, internal: boolean): Promise<string[]> {
  if (!(await keyManager.isUnlocked())) {
    // Check if wallet exists
    const hasWallet = await keyManager.hasWallet();
    if (!hasWallet) return [];

    // Rate limit: prevent malicious dApps from spamming unlock popups
    const now = Date.now();
    if (now - lastUnlockPromptTime < UNLOCK_PROMPT_COOLDOWN_MS) {
      throw userRejection('Too many connection requests, please wait');
    }
    lastUnlockPromptTime = now;

    // Wallet is locked — prompt user to unlock
    const unlocked = await requestUnlock(origin);
    if (!unlocked || !(await keyManager.isUnlocked())) {
      throw userRejection('User rejected the connection request');
    }
  }

  if (!internal && !(await isSiteConnected(origin))) {
    await requestConnection(origin);
  }
  return [await keyManager.getAddress()];
}

// One connect prompt per site at a time; repeat calls share its answer.
const pendingConnections = new Map<string, Promise<void>>();

function requestConnection(origin: string): Promise<void> {
  const site = siteOrigin(origin);
  if (!site) throw userRejection(`Cannot connect ${origin}: not a web site`);
  const existing = pendingConnections.get(site);
  if (existing) return existing;

  const prompt = (async () => {
    const info = await keyManager.getActiveAccountInfo();
    const network = await networkManager.getActiveNetwork();
    const { approved } = await requestUserConfirmation({
      id: genId(),
      method: 'eth_requestAccounts',
      origin: site,
      params: [],
      signerAddress: info.address,
      chainId: network.chainId,
      chainName: network.name,
      nativeSymbol: network.symbol,
    });
    if (!approved) throw userRejection('User rejected the connection request');
    await connectSite(site);
    // Other tabs of the same site re-query eth_accounts and see the account.
    emitAccountsChanged();
  })();
  pendingConnections.set(site, prompt);
  prompt.finally(() => pendingConnections.delete(site)).catch(() => undefined);
  return prompt;
}

async function accountsPermission(origin: string, accounts: string[]) {
  const site = siteOrigin(origin);
  const record = (await getConnectedSites()).find((s) => s.origin === site);
  return {
    invoker: site ?? origin,
    parentCapability: 'eth_accounts',
    caveats: [{ type: 'restrictReturnedAccounts', value: accounts }],
    date: record?.connectedAt ?? Date.now(),
  };
}

async function handleRequestPermissions(params: unknown[], origin: string, internal: boolean): Promise<unknown[]> {
  const requested = params[0] as Record<string, unknown> | undefined;
  if (!requested || typeof requested !== 'object' || !('eth_accounts' in requested)) {
    throw new RpcError('wallet_requestPermissions: only eth_accounts is supported', -32602);
  }
  const accounts = await handleRequestAccounts(origin, internal);
  return [await accountsPermission(origin, accounts)];
}

async function handleGetPermissions(origin: string, internal: boolean): Promise<unknown[]> {
  if (!internal && !(await isSiteConnected(origin))) return [];
  return [await accountsPermission(origin, await handleAccounts(origin, internal))];
}

async function handleRevokePermissions(origin: string): Promise<null> {
  await disconnectSite(origin);
  emitAccountsChanged();
  return null;
}

/** Make `chainId` active and tell dApps, unless it already is. */
async function switchToChain(chainId: number): Promise<void> {
  if ((await networkManager.getActiveChainId()) === chainId) return;
  await networkManager.switchNetwork(chainId);
  emitChainChanged(toHex(chainId));
}

/**
 * Only the tab the user is looking at may change the wallet's network.
 * Requests from background tabs are refused (not silently "succeeded"), so the
 * dApp doesn't go on believing it is on the chain it asked for.
 */
async function assertForeground(method: string, sender: chrome.runtime.MessageSender, internal: boolean): Promise<void> {
  if (internal) return;
  const windowId = sender.tab?.windowId;
  const window = windowId === undefined ? null : await chrome.windows.get(windowId);
  if (isForegroundTab(sender, window)) return;
  throw userRejection(`Ignored ${method}: only the tab you are viewing can switch networks`);
}

async function handleSwitchChain(params: unknown[], sender: chrome.runtime.MessageSender, internal: boolean): Promise<null> {
  const id = parseSwitchChainParams(params);
  await assertForeground('wallet_switchEthereumChain', sender, internal);

  // EIP-3326: signal "unrecognized chain" with code 4902 so dapps (wagmi/viem)
  // can fall back to wallet_addEthereumChain instead of treating it as a generic failure.
  const all = await networkManager.getAllNetworks();
  if (!all.find((n) => n.chainId === id)) {
    throw new RpcError(
      `Unrecognized chain ID "0x${id.toString(16)}". Try adding the chain using wallet_addEthereumChain first.`,
      4902,
    );
  }

  await switchToChain(id);
  return null;
}

async function handleAddChain(
  params: unknown[],
  origin: string,
  sender: chrome.runtime.MessageSender,
  internal: boolean,
): Promise<null> {
  const parsed = parseAddChainParams(params);
  await assertForeground('wallet_addEthereumChain', sender, internal);

  // If chain already exists, just switch to it
  const all = await networkManager.getAllNetworks();
  if (all.find((n) => n.chainId === parsed.chainId)) {
    await switchToChain(parsed.chainId);
    return null;
  }

  // SECURITY: Validate RPC URL is HTTPS
  const urlCheck = validateRpcUrl(parsed.rpcUrl);
  if (!urlCheck.valid) {
    throw userRejection(urlCheck.reason!);
  }

  // SECURITY: Require user confirmation before adding unknown chain
  const { approved } = await requestUserConfirmation({
    id: genId(),
    method: 'wallet_addEthereumChain',
    origin,
    params: [{
      chainId: toHex(parsed.chainId),
      chainName: parsed.chainName,
      rpcUrl: parsed.rpcUrl,
      symbol: parsed.symbol,
    }],
  });
  if (!approved) {
    throw userRejection('User rejected adding the network');
  }

  await networkManager.addCustomNetwork({
    chainId: parsed.chainId,
    name: parsed.chainName,
    rpcUrl: parsed.rpcUrl,
    symbol: parsed.symbol,
    decimals: parsed.decimals,
    blockExplorerUrl: parsed.blockExplorerUrl,
    isCustom: true,
  });
  await switchToChain(parsed.chainId);
  return null;
}

// --- Common signing flow: whitelist check + confirm popup ---

async function checkWhitelistOrConfirm(
  method: string,
  origin: string,
  params: unknown[],
  ctx: { to: string | null; data: string | null; value: string; gasLimit: string | null; chainId: number },
  signerAddress: string,
  ledger?: LedgerConfirmContext,
  simulationPromise?: Promise<SimulationPreview>,
  chainName?: string,
  nativeSymbol?: string,
): Promise<{
  autoSignResult: whitelist.AutoSignCheckResult;
  feeOverride: FeeOverride | null;
  txDataOverride: `0x${string}` | null;
  signedRawTx: `0x${string}` | null;
  signature: `0x${string}` | null;
}> {
  const autoSignResult = ledger
    // Ledger requires a physical button press; auto-sign whitelist doesn't apply.
    ? { allowed: false } as whitelist.AutoSignCheckResult
    : await whitelist.checkAutoSign({
        origin,
        to: ctx.to,
        data: ctx.data,
        value: ctx.value,
        gasLimit: ctx.gasLimit,
        chainId: ctx.chainId,
      });

  if (autoSignResult.allowed) {
    return { autoSignResult, feeOverride: null, txDataOverride: null, signedRawTx: null, signature: null };
  }

  const { approved, feeOverride, txDataOverride, signedRawTx, signature } = await requestUserConfirmation(
    {
      id: genId(),
      method,
      origin,
      params,
      signerAddress,
      chainId: ctx.chainId,
      chainName,
      nativeSymbol,
      ledger,
    },
    simulationPromise ? { simulationPromise } : undefined,
  );
  if (!approved) {
    throw userRejection('User rejected the request');
  }
  return {
    autoSignResult,
    feeOverride: feeOverride ?? null,
    txDataOverride: txDataOverride ?? null,
    signedRawTx: signedRawTx ?? null,
    signature: signature ?? null,
  };
}

// Resolve gas per the wallet's gas policy (see applyGasPolicy in lib/gas):
// dApp/parsed-tx values are trusted verbatim, fresh estimates get the ×1.2
// buffer.
async function resolveTxGas(
  publicClient: PublicClient,
  parsed: ReturnType<typeof parseTxParams>,
  fromAddress: string,
): Promise<bigint> {
  return applyGasPolicy(parsed.gasLimitBigInt, () => publicClient.estimateGas({
    account: fromAddress as `0x${string}`,
    to: parsed.to as `0x${string}` | undefined,
    data: (parsed.data as `0x${string}`) ?? undefined,
    value: parsed.valueBigInt,
  }));
}

interface BuildLedgerTxArgs {
  chainId: number;
  nonce: number;
  gas: bigint;
  parsed: ReturnType<typeof parseTxParams>;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
  publicClient: PublicClient;
}

/** Compose a fully-specified, JSON-friendly tx for Ledger signing in the confirm popup. */
async function buildLedgerTxJson(args: BuildLedgerTxArgs): Promise<SerializedTxJSON> {
  const { chainId, nonce, gas, parsed, publicClient } = args;
  let { maxFeePerGas, maxPriorityFeePerGas, gasPrice } = args;

  let type: 'eip1559' | 'legacy';
  if (maxFeePerGas) {
    type = 'eip1559';
    if (!maxPriorityFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  } else if (gasPrice) {
    type = 'legacy';
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

  return {
    type,
    to: (parsed.to ?? '0x') as `0x${string}`,
    value: parsed.valueBigInt.toString(),
    data: (parsed.data as `0x${string}` | undefined) ?? undefined,
    gas: gas.toString(),
    nonce,
    chainId,
    maxFeePerGas: maxFeePerGas?.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(),
    gasPrice: gasPrice?.toString(),
  };
}

/** dApp-supplied tx.nonce: a hex quantity within safe-integer range, or absent. */
function parseDappNonce(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new RpcError(`Invalid transaction nonce ${JSON.stringify(raw)}`, -32602);
  }
  const n = hexToBigInt(raw as `0x${string}`);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcError(`Transaction nonce ${raw} is too large`, -32602);
  return Number(n);
}

async function handleSendTransaction(params: unknown[], origin: string): Promise<string> {
  await assertActiveAccountCanSign();
  const network = await networkManager.getActiveNetwork();
  const chainId = network.chainId;
  const ledger = await getLedgerContextOrNull();

  const tx = params[0] as Record<string, string>;
  const parsed = parseTxParams(tx);

  const signerAddress = ledger ? ledger.address : (await keyManager.getAccount()).address;
  // SECURITY: Validate tx.from matches active account if specified
  validateSigner(parsed.from ?? undefined, signerAddress);

  const publicClient = await networkManager.getClient(chainId);
  const finalGas = await resolveTxGas(publicClient, parsed, signerAddress);

  // Resolve fees from dApp params; user-provided overrides come back from the confirm popup.
  const txMaxFee = tx.maxFeePerGas ? hexToBigInt(tx.maxFeePerGas as `0x${string}`) : null;
  const txPriority = tx.maxPriorityFeePerGas ? hexToBigInt(tx.maxPriorityFeePerGas as `0x${string}`) : null;
  const txGasPrice = tx.gasPrice ? hexToBigInt(tx.gasPrice as `0x${string}`) : null;
  // Parsed before the popup opens so a malformed value fails here, not after approval.
  const dappNonce = parseDappNonce(tx.nonce);

  let ledgerCtx: LedgerConfirmContext | undefined;
  let preparedTxJson: SerializedTxJSON | undefined;
  if (ledger) {
    // Ledger: build a prepared tx so the confirm popup can sign + re-serialize.
    const nonce = dappNonce ?? await publicClient.getTransactionCount({
      address: signerAddress as `0x${string}`,
      blockTag: 'pending',
    });
    preparedTxJson = await buildLedgerTxJson({
      chainId, nonce, gas: finalGas, parsed,
      maxFeePerGas: txMaxFee, maxPriorityFeePerGas: txPriority, gasPrice: txGasPrice,
      publicClient,
    });
    ledgerCtx = {
      derivationPath: ledger.derivationPath,
      txJson: preparedTxJson,
    };
  }

  // Kick off simulation in parallel so the confirm popup can open immediately.
  // The popup picks up the resolved result via session storage; on the auto-sign
  // path the promise is simply discarded.
  const simulationPromise = simulateTx({
    chainId,
    from: signerAddress,
    to: parsed.to,
    input: parsed.data,
    value: parsed.valueBigInt,
    gas: finalGas,
    nativeSymbol: network.symbol,
  });

  const { autoSignResult, feeOverride, txDataOverride, signedRawTx } = await checkWhitelistOrConfirm(
    'eth_sendTransaction',
    origin,
    [tx],
    {
      to: parsed.to,
      data: parsed.data,
      value: String(parsed.valueBigInt),
      gasLimit: String(finalGas),
      chainId,
    },
    signerAddress,
    ledgerCtx,
    simulationPromise,
    network.name,
    network.symbol,
  );

  let hash: `0x${string}`;
  let effNonce: number | null = null;
  const effectiveData = txDataOverride ?? parsed.data;
  let effGas = finalGas;
  let effMaxFee = txMaxFee;
  let effPriority = txPriority;
  let effGasPrice = txGasPrice;

  if (ledger) {
    if (!signedRawTx) {
      throw userRejection('Ledger did not return a signed transaction');
    }
    hash = await publicClient.sendRawTransaction({ serializedTransaction: signedRawTx });
    // The popup may have changed fees or nonce before signing — log what was
    // actually signed.
    const signed = parseTransaction(signedRawTx);
    effGas = signed.gas ?? finalGas;
    effMaxFee = signed.maxFeePerGas ?? null;
    effPriority = signed.maxPriorityFeePerGas ?? null;
    effGasPrice = signed.gasPrice ?? null;
    effNonce = signed.nonce ?? null;
  } else {
    const account = await keyManager.getAccount();
    const overrideGas = feeOverride?.gas ? BigInt(feeOverride.gas) : null;
    const overrideMaxFee = feeOverride?.maxFeePerGas ? BigInt(feeOverride.maxFeePerGas) : null;
    const overridePriority = feeOverride?.maxPriorityFeePerGas ? BigInt(feeOverride.maxPriorityFeePerGas) : null;
    const overrideGasPrice = feeOverride?.gasPrice ? BigInt(feeOverride.gasPrice) : null;
    effGas = overrideGas ?? finalGas;
    effMaxFee = overrideMaxFee ?? txMaxFee;
    effPriority = overridePriority ?? txPriority;
    effGasPrice = overrideGasPrice ?? txGasPrice;

    const client = await networkManager.getWalletClient(account);
    const chain = networkManager.buildViemChain(network);
    // Nonce priority: what the user typed in the popup > what the dApp asked
    // for > automatic. A chosen nonce is sent as-is (no silent retry).
    const fixedNonce = parseNonceInput(feeOverride?.nonce) ?? dappNonce;
    hash = await sendWithNonce(fixedNonce, async (nonceOverride) => {
      const nonce = nonceOverride ?? await publicClient.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      });
      effNonce = nonce;
      const txArgs: any = {
        to: parsed.to as `0x${string}`,
        value: parsed.valueBigInt,
        data: (effectiveData as `0x${string}`) ?? undefined,
        gas: effGas,
        nonce,
        chain,
      };
      if (effMaxFee !== null) {
        txArgs.maxFeePerGas = effMaxFee;
        if (effPriority !== null) txArgs.maxPriorityFeePerGas = effPriority;
      } else if (effGasPrice !== null) {
        txArgs.gasPrice = effGasPrice;
      }
      return client.sendTransaction(txArgs);
    });
  }

  // Log the transaction (capture the requested fee values so we can compare to actual)
  const logId = genId();
  await txLogger.appendLog({
    id: logId,
    timestamp: Date.now(),
    chainId,
    from: signerAddress,
    to: parsed.to ?? '',
    value: String(parsed.valueBigInt),
    hash,
    method: parsed.methodSelector,
    origin,
    autoSigned: autoSignResult.allowed,
    ruleId: autoSignResult.rule?.id,
    status: 'pending',
    nonce: effNonce ?? undefined,
    gasLimit: effGas.toString(),
    maxFeePerGas: effMaxFee?.toString(),
    maxPriorityFeePerGas: effPriority?.toString(),
    gasPrice: effGasPrice?.toString(),
  });

  // Poll for receipt — notification fires from there once status is known.
  pollTxReceipt(logId, chainId, hash, origin, autoSignResult.allowed, network.blockExplorerUrl);

  return hash;
}

async function handlePersonalSign(params: unknown[], origin: string): Promise<string> {
  await assertActiveAccountCanSign();
  const ledger = await getLedgerContextOrNull();
  const network = await networkManager.getActiveNetwork();
  const chainId = network.chainId;
  const signerAddress = ledger ? ledger.address : (await keyManager.getAccount()).address;
  const { messageHex } = preparePersonalSignParams(params, signerAddress);

  const ledgerCtx: LedgerConfirmContext | undefined = ledger
    ? { derivationPath: ledger.derivationPath, messageHex }
    : undefined;

  const { autoSignResult, signature } = await checkWhitelistOrConfirm(
    'personal_sign',
    origin,
    params,
    { to: null, data: null, value: '0', gasLimit: null, chainId },
    signerAddress,
    ledgerCtx,
    undefined,
    network.name,
    network.symbol,
  );

  let sig: `0x${string}`;
  if (ledger) {
    if (!signature) throw userRejection('Ledger did not return a signature');
    sig = signature;
  } else {
    const account = await keyManager.getAccount();
    sig = await signPreparedPersonalMessage(messageHex, account);
  }
  notifySign('personal_sign', origin, autoSignResult.allowed);
  return sig;
}

async function handleSignTypedData(method: string, params: unknown[], origin: string): Promise<string> {
  await assertActiveAccountCanSign();
  const ledger = await getLedgerContextOrNull();
  const network = await networkManager.getActiveNetwork();
  const chainId = network.chainId;
  const signerAddress = ledger ? ledger.address : (await keyManager.getAccount()).address;

  const { address, typedData } = parseTypedDataRequest(method, params);
  // SECURITY: Validate requested address matches active account
  validateSigner(address, signerAddress);
  // SECURITY: the popup labels the request with the active chain, so typed
  // data for any other chain is refused.
  assertTypedDataChain(typedData, chainId);

  let ledgerCtx: LedgerConfirmContext | undefined;
  if (ledger) {
    // Compute the EIP-712 hashes here so the popup can use the
    // hashed-message variant (compatible with all Ledger Eth-app versions).
    // Same domain-type derivation viem's signTypedData uses when the dApp
    // omits EIP712Domain, so Ledger and software keys sign the same hash.
    const domain = typedData.domain as TypedDataDomain;
    // Typed data arrives as untyped JSON, so viem's generic inference can't help here.
    const domainSeparator = hashDomain({
      domain,
      types: { EIP712Domain: typedData.types.EIP712Domain ?? getTypesForEIP712Domain({ domain }) },
    } as Parameters<typeof hashDomain>[0]);
    const { EIP712Domain: _omit, ...nonDomainTypes } = typedData.types;
    const messageStructHash = hashStruct({
      data: typedData.message,
      primaryType: typedData.primaryType,
      types: nonDomainTypes,
    });
    ledgerCtx = {
      derivationPath: ledger.derivationPath,
      domainSeparator,
      hashStructMessage: messageStructHash,
    };
  }

  const { autoSignResult, signature } = await checkWhitelistOrConfirm(
    'eth_signTypedData_v4',
    origin,
    [address, typedData],
    { to: null, data: null, value: '0', gasLimit: null, chainId },
    signerAddress,
    ledgerCtx,
    undefined,
    network.name,
    network.symbol,
  );

  let sig: `0x${string}`;
  if (ledger) {
    if (!signature) throw userRejection('Ledger did not return a signature');
    sig = signature;
  } else {
    const account = await keyManager.getAccount();
    sig = await account.signTypedData(typedData as any);
  }
  notifySign('eth_signTypedData_v4', origin, autoSignResult.allowed);
  return sig;
}

async function handleWatchAsset(params: unknown, origin: string): Promise<boolean> {
  const request = parseWatchAssetParams(params);
  const network = await networkManager.getActiveNetwork();
  if (await tokenManager.hasToken(network.chainId, request.address)) return true;

  // Show what the chain says, not what the site claims: a site could pass a
  // fake symbol like "USDC" for a scam token.
  const token = await tokenManager.fetchTokenInfo(network.chainId, request.address);
  const { approved } = await requestUserConfirmation({
    id: genId(),
    method: 'wallet_watchAsset',
    origin,
    params: [{
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      name: token.name,
      requestedSymbol: request.symbol,
      requestedDecimals: request.decimals,
    }],
    chainId: network.chainId,
    chainName: network.name,
    nativeSymbol: network.symbol,
  });
  if (!approved) throw userRejection('User rejected adding the token');
  await tokenManager.saveToken(token);
  return true;
}

async function forwardToNode(method: string, params: unknown[]): Promise<unknown> {
  const network = await networkManager.getActiveNetwork();
  let response: Response;
  try {
    response = await fetch(network.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (err: any) {
    throw new RpcError(
      `RPC request failed: ${err.message ?? 'network error'}`,
      -32603,
    );
  }
  if (!response.ok) {
    throw new RpcError(
      `RPC returned HTTP ${response.status}`,
      -32603,
    );
  }
  const json = await response.json();
  if (json.error) throw json.error;
  return json.result;
}

