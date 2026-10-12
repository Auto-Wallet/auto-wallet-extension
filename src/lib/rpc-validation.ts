// Pure validation functions for RPC requests.
// Zero IO — fully testable with plain data.

import { hexToBigInt } from 'viem';
import { RpcError } from './rpc-error';

/** EIP-1474 "invalid params". */
function invalidParams(message: string): RpcError {
  return new RpcError(message, -32602);
}

// --- Signer validation ---

/**
 * Validate that tx.from matches the active account address.
 * Throws if they don't match. No-op if from is undefined.
 */
export function validateSigner(txFrom: string | undefined, accountAddress: string): void {
  if (txFrom && txFrom.toLowerCase() !== accountAddress.toLowerCase()) {
    throw new Error(`Requested signer ${txFrom} does not match active account ${accountAddress}`);
  }
}

// --- RPC URL validation ---

export interface UrlValidation {
  valid: boolean;
  reason?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate that an RPC URL uses HTTPS, or plain HTTP to a loopback host for
 * local dev nodes. The URL is parsed so a host like `localhost.evil.com` or
 * `localhost@evil.com` cannot pass as localhost.
 */
export function validateRpcUrl(url: string | undefined): UrlValidation {
  if (!url) return { valid: false, reason: 'No RPC URL provided' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'RPC URL is not a valid URL' };
  }
  if (parsed.protocol === 'https:' && parsed.hostname) return { valid: true };
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return { valid: true };
  return { valid: false, reason: 'Only HTTPS RPC URLs are allowed' };
}

// --- Chain id parsing ---

/**
 * Parse an EIP-695 chain id: a 0x-prefixed hex string with no leading zeros,
 * greater than zero and within JS safe-integer range.
 */
export function parseChainIdHex(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[1-9a-fA-F][0-9a-fA-F]*$/.test(value)) {
    throw invalidParams(`Invalid chainId ${JSON.stringify(value)}: expected a 0x-prefixed hex string without leading zeros`);
  }
  const big = BigInt(value);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidParams(`Invalid chainId ${value}: value is too large`);
  }
  return Number(big);
}

/** Parse wallet_switchEthereumChain params: `[{ chainId: '0x…' }]`. */
export function parseSwitchChainParams(params: unknown[]): number {
  const p = params[0];
  if (!p || typeof p !== 'object') {
    throw invalidParams('wallet_switchEthereumChain expects [{ chainId }]');
  }
  return parseChainIdHex((p as { chainId?: unknown }).chainId);
}

// --- AddEthereumChain parameter parsing ---

export interface ParsedAddChainParams {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  symbol: string;
  decimals: number;
  blockExplorerUrl?: string;
}

const MAX_CHAIN_NAME_LENGTH = 64;
const MAX_SYMBOL_LENGTH = 12;
const MAX_DECIMALS = 36;

/** Parse and validate wallet_addEthereumChain params (EIP-3085). */
export function parseAddChainParams(params: unknown[]): ParsedAddChainParams {
  const p = params[0] as {
    chainId?: unknown;
    chainName?: unknown;
    rpcUrls?: unknown;
    nativeCurrency?: { name?: unknown; symbol?: unknown; decimals?: unknown };
    blockExplorerUrls?: unknown;
  } | undefined;
  if (!p || typeof p !== 'object') {
    throw invalidParams('wallet_addEthereumChain expects [{ chainId, chainName, rpcUrls, nativeCurrency }]');
  }

  const chainId = parseChainIdHex(p.chainId);

  if (typeof p.chainName !== 'string' || !p.chainName.trim() || p.chainName.trim().length > MAX_CHAIN_NAME_LENGTH) {
    throw invalidParams(`chainName must be a non-empty string of at most ${MAX_CHAIN_NAME_LENGTH} characters`);
  }

  if (!Array.isArray(p.rpcUrls) || p.rpcUrls.length === 0 || typeof p.rpcUrls[0] !== 'string') {
    throw invalidParams('rpcUrls must be a non-empty array of URL strings');
  }

  const nc = p.nativeCurrency;
  if (!nc || typeof nc !== 'object') {
    throw invalidParams('nativeCurrency is required');
  }
  if (typeof nc.symbol !== 'string' || !nc.symbol.trim() || nc.symbol.trim().length > MAX_SYMBOL_LENGTH) {
    throw invalidParams(`nativeCurrency.symbol must be 1-${MAX_SYMBOL_LENGTH} characters`);
  }
  if (typeof nc.decimals !== 'number' || !Number.isInteger(nc.decimals) || nc.decimals < 0 || nc.decimals > MAX_DECIMALS) {
    throw invalidParams(`nativeCurrency.decimals must be an integer between 0 and ${MAX_DECIMALS}`);
  }

  let blockExplorerUrl: string | undefined;
  if (p.blockExplorerUrls !== undefined && p.blockExplorerUrls !== null) {
    if (!Array.isArray(p.blockExplorerUrls)) throw invalidParams('blockExplorerUrls must be an array');
    const first = p.blockExplorerUrls[0];
    if (first !== undefined) {
      if (typeof first !== 'string' || !first.startsWith('https://')) {
        throw invalidParams('blockExplorerUrls entries must be https URLs');
      }
      blockExplorerUrl = first;
    }
  }

  return {
    chainId,
    chainName: p.chainName.trim(),
    rpcUrl: p.rpcUrls[0],
    symbol: nc.symbol.trim(),
    decimals: nc.decimals,
    blockExplorerUrl,
  };
}

// --- Transaction parameter parsing ---

export interface ParsedTxParams {
  to: string | null;
  value: string;            // hex string
  valueBigInt: bigint;      // wei
  gasLimit: string | null;  // hex string or null
  gasLimitBigInt: bigint | null;
  data: string | null;
  from: string | null;
  methodSelector: string | undefined; // first 4 bytes of data
}

/** Parse raw tx params into a typed structure. */
export function parseTxParams(tx: Record<string, string>): ParsedTxParams {
  const value = tx.value ?? '0x0';
  const gasLimit = tx.gas ?? tx.gasLimit ?? null;

  return {
    to: tx.to ?? null,
    value,
    valueBigInt: hexToBigInt(value as `0x${string}`),
    gasLimit,
    gasLimitBigInt: gasLimit ? hexToBigInt(gasLimit as `0x${string}`) : null,
    data: tx.data ?? null,
    from: tx.from ?? null,
    methodSelector: tx.data?.slice(0, 10) ?? undefined,
  };
}
