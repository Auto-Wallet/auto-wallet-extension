// Pure parsing / policy helpers for dApp RPC methods. Zero IO.

import { getAddress, isAddress } from 'viem';
import { RpcError } from './rpc-error';

function invalidParams(message: string): RpcError {
  return new RpcError(message, -32602);
}

// --- EIP-712 typed data ---

export interface TypedDataPayload {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

/**
 * Parse eth_signTypedData{,_v3,_v4} params `[address, typedData]`, where
 * typedData is an object or its JSON string. The legacy v1 format (an array of
 * {type,name,value} as the first param) is not supported.
 */
export function parseTypedDataRequest(method: string, params: unknown[]): { address: string; typedData: TypedDataPayload } {
  if (Array.isArray(params[0])) {
    throw new RpcError(`${method}: the legacy v1 typed-data format is not supported, use eth_signTypedData_v4`, 4200);
  }
  const address = params[0];
  if (typeof address !== 'string' || !isAddress(address)) {
    throw invalidParams(`${method}: first param must be the signer address`);
  }

  let raw = params[1];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw invalidParams(`${method}: typed data is not valid JSON`);
    }
  }
  if (!raw || typeof raw !== 'object') throw invalidParams(`${method}: typed data is missing`);
  const td = raw as Partial<TypedDataPayload>;
  if (!td.types || typeof td.types !== 'object') throw invalidParams(`${method}: typed data has no types`);
  if (typeof td.primaryType !== 'string' || !(td.primaryType in td.types)) {
    throw invalidParams(`${method}: primaryType must name one of the declared types`);
  }
  if (!td.domain || typeof td.domain !== 'object') throw invalidParams(`${method}: typed data has no domain`);
  if (!td.message || typeof td.message !== 'object') throw invalidParams(`${method}: typed data has no message`);

  return { address, typedData: td as TypedDataPayload };
}

function parseDomainChainId(value: unknown): number {
  let n: bigint;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    n = BigInt(value);
  } else if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    n = BigInt(value);
  } else {
    throw invalidParams(`Typed data domain.chainId ${JSON.stringify(value)} is not a valid chain id`);
  }
  if (n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidParams(`Typed data domain.chainId ${String(value)} is out of range`);
  }
  return Number(n);
}

/**
 * Typed data naming a chain must name the active one: the confirm popup shows
 * the active chain, so a signature for another chain would be mislabelled.
 */
export function assertTypedDataChain(typedData: TypedDataPayload, activeChainId: number): void {
  if (!('chainId' in typedData.domain) || typedData.domain.chainId === undefined) return;
  const chainId = parseDomainChainId(typedData.domain.chainId);
  if (chainId !== activeChainId) {
    throw invalidParams(`Typed data chainId ${chainId} must match the active chain ${activeChainId}`);
  }
}

// --- wallet_watchAsset (EIP-747) ---

export interface WatchAssetRequest {
  address: string;        // checksummed
  symbol?: string;        // as suggested by the dApp (display only)
  decimals?: number;      // as suggested by the dApp (display only)
}

export function parseWatchAssetParams(raw: unknown): WatchAssetRequest {
  const p = (Array.isArray(raw) ? raw[0] : raw) as { type?: unknown; options?: Record<string, unknown> } | undefined;
  if (!p || typeof p !== 'object') throw invalidParams('wallet_watchAsset expects { type, options }');
  if (p.type !== 'ERC20') throw invalidParams('Only ERC20 tokens are supported');
  const o = p.options;
  if (!o || typeof o !== 'object') throw invalidParams('wallet_watchAsset: options are missing');
  if (typeof o.address !== 'string' || !isAddress(o.address, { strict: false })) {
    throw invalidParams('wallet_watchAsset: options.address is not a valid address');
  }
  if (o.decimals !== undefined && (typeof o.decimals !== 'number' || !Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 36)) {
    throw invalidParams('wallet_watchAsset: options.decimals must be an integer between 0 and 36');
  }
  return {
    address: getAddress(o.address),
    symbol: typeof o.symbol === 'string' ? o.symbol : undefined,
    decimals: o.decimals as number | undefined,
  };
}

// --- Tab focus ---

/** True when the request came from the tab the user is looking at (the active tab of its window). */
export function isForegroundTab(sender: Pick<chrome.runtime.MessageSender, 'tab'>): boolean {
  return sender.tab?.active === true;
}
