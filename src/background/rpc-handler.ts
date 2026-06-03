import {
  toHex,
  hexToBigInt,
  serializeTransaction,
  hashDomain,
  hashStruct,
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
import { notifyTx, notifySign } from '../lib/notify';
import { emitChainChanged } from './events';
import { RpcError, userRejection } from '../lib/rpc-error';
import { validateSigner, validateRpcUrl, parseAddChainParams, parseTxParams } from '../lib/rpc-validation';
import { applyGasPolicy, clampEstimatedFees } from '../lib/gas';
import { simulateTx, type SimulationPreview } from './bcs-simulation';
import { preparePersonalSignParams, signPreparedPersonalMessage } from '../lib/signing';
import { retryWithNextNonce } from '../lib/nonce';

// --- Rate limiting for eth_requestAccounts ---
let lastUnlockPromptTime = 0;
const UNLOCK_PROMPT_COOLDOWN_MS = 3000; // 3 seconds between unlock popups

// --- RPC Method Router ---

export async function handleRpcMethod(
  method: string,
  params: unknown[],
  origin: string,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (method) {
    // --- Account methods ---
    case 'eth_requestAccounts':
      return handleRequestAccounts(origin);
    case 'eth_accounts':
      return handleAccounts();

    // --- Chain methods ---
    case 'eth_chainId':
      return toHex(await networkManager.getActiveChainId());

    case 'net_version':
      return String(await networkManager.getActiveChainId());

    case 'wallet_switchEthereumChain':
      return handleSwitchChain(params);

    case 'wallet_addEthereumChain':
      return handleAddChain(params, origin);

    // --- Signing ---
    case 'eth_sendTransaction':
      return handleSendTransaction(params, origin);

    case 'personal_sign':
    case 'eth_sign':
      return handlePersonalSign(params, origin);

    case 'eth_signTypedData_v4':
    case 'eth_signTypedData':
      return handleSignTypedData(params, origin);

    // --- Token ---
    case 'wallet_watchAsset':
      return handleWatchAsset(params);

    // --- Read-only RPC: forward to node ---
    default:
      return forwardToNode(method, params);
  }
}

// --- Handlers ---

async function handleAccounts(): Promise<string[]> {
  if (!(await keyManager.isUnlocked())) return [];
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

async function handleRequestAccounts(origin: string): Promise<string[]> {
  // If already unlocked, return accounts directly
  if (await keyManager.isUnlocked()) return [await keyManager.getAddress()];

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

  return [await keyManager.getAddress()];
}

async function handleSwitchChain(params: unknown[]): Promise<null> {
  const { chainId } = params[0] as { chainId: string };
  const id = parseInt(chainId, 16);

  // EIP-3326: signal "unrecognized chain" with code 4902 so dapps (wagmi/viem)
  // can fall back to wallet_addEthereumChain instead of treating it as a generic failure.
  const all = await networkManager.getAllNetworks();
  if (!all.find((n) => n.chainId === id)) {
    throw new RpcError(
      `Unrecognized chain ID "0x${id.toString(16)}". Try adding the chain using wallet_addEthereumChain first.`,
      4902,
    );
  }

  await networkManager.switchNetwork(id);
  emitChainChanged(chainId);
  return null;
}

async function handleAddChain(params: unknown[], origin: string): Promise<null> {
  const parsed = parseAddChainParams(params);

  // If chain already exists, just switch to it
  const all = await networkManager.getAllNetworks();
  if (all.find((n) => n.chainId === parsed.chainId)) {
    await networkManager.switchNetwork(parsed.chainId);
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
  await networkManager.switchNetwork(parsed.chainId);
  emitChainChanged(toHex(parsed.chainId));
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

  let ledgerCtx: LedgerConfirmContext | undefined;
  let preparedTxJson: SerializedTxJSON | undefined;
  if (ledger) {
    // Ledger: build a prepared tx so the confirm popup can sign + re-serialize.
    const nonce = await publicClient.getTransactionCount({
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
    // For logging, prefer fee values from the prepared tx (popup may have updated via feeOverride
    // — but that override is already baked into the signed bytes; the prepared tx is the best
    // estimate we have without re-parsing the raw tx).
    if (preparedTxJson) {
      effGas = BigInt(preparedTxJson.gas);
      effMaxFee = preparedTxJson.maxFeePerGas ? BigInt(preparedTxJson.maxFeePerGas) : null;
      effPriority = preparedTxJson.maxPriorityFeePerGas ? BigInt(preparedTxJson.maxPriorityFeePerGas) : null;
      effGasPrice = preparedTxJson.gasPrice ? BigInt(preparedTxJson.gasPrice) : null;
      effNonce = preparedTxJson.nonce;
    }
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
    const requestedNonce = tx.nonce ? Number(hexToBigInt(tx.nonce as `0x${string}`)) : null;
    hash = await retryWithNextNonce(async (nonceOverride) => {
      const nonce = requestedNonce ?? nonceOverride ?? await publicClient.getTransactionCount({
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

async function handleSignTypedData(params: unknown[], origin: string): Promise<string> {
  await assertActiveAccountCanSign();
  const ledger = await getLedgerContextOrNull();
  const network = await networkManager.getActiveNetwork();
  const chainId = network.chainId;
  const signerAddress = ledger ? ledger.address : (await keyManager.getAccount()).address;

  // SECURITY: Validate requested address matches active account
  validateSigner(params[0] as string | undefined, signerAddress);

  const typedData = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];

  let ledgerCtx: LedgerConfirmContext | undefined;
  if (ledger) {
    // Compute the EIP-712 hashes here so the popup can use the
    // hashed-message variant (compatible with all Ledger Eth-app versions).
    const domainSeparator = hashDomain({
      domain: typedData.domain,
      types: { EIP712Domain: typedData.types.EIP712Domain },
    });
    const { EIP712Domain: _omit, ...nonDomainTypes } = typedData.types ?? {};
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
    sig = await account.signTypedData(typedData);
  }
  notifySign('eth_signTypedData_v4', origin, autoSignResult.allowed);
  return sig;
}


async function handleWatchAsset(params: unknown[]): Promise<boolean> {
  const p = params[0] as { type: string; options: { address: string; symbol?: string; decimals?: number } };
  if (p.type !== 'ERC20') throw new Error('Only ERC20 tokens are supported');
  const network = await networkManager.getActiveNetwork();
  await tokenManager.addToken(network.chainId, p.options.address);
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

// --- Tx receipt polling ---

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
