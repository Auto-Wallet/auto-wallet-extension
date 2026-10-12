import type { Token } from '../types/token';
import { getItem, setItem, STORAGE_KEYS } from './storage';
import { getClient } from './network-manager';
import { erc20Abi, formatUnits, getAddress } from 'viem';

// --- Storage ---

export async function getTokens(): Promise<Token[]> {
  return (await getItem<Token[]>(STORAGE_KEYS.TOKENS)) ?? [];
}

async function saveTokens(tokens: Token[]): Promise<void> {
  await setItem(STORAGE_KEYS.TOKENS, tokens);
}

// --- Public API ---

/** Fetch on-chain symbol & decimals, then store the token. */
export async function addToken(chainId: number, address: string): Promise<Token> {
  const token = await fetchTokenInfo(chainId, address);
  await saveToken(token);
  return token;
}

/** Read a token's symbol / decimals / name from chain without storing it. */
export async function fetchTokenInfo(chainId: number, address: string): Promise<Token> {
  const checksummed = getAddress(address);
  const client = await getClient(chainId);

  const [symbol, decimals, name] = await Promise.all([
    client.readContract({ address: checksummed, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: checksummed, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address: checksummed, abi: erc20Abi, functionName: 'name' }).catch(() => undefined),
  ]);

  return {
    chainId,
    address: checksummed,
    symbol: symbol as string,
    decimals: Number(decimals),
    name: name as string | undefined,
    isCustom: true,
  };
}

/** Insert or replace a token in the user's list. */
export async function saveToken(token: Token): Promise<void> {
  const tokens = await getTokens();
  const idx = tokens.findIndex((t) => t.chainId === token.chainId && t.address.toLowerCase() === token.address.toLowerCase());
  if (idx >= 0) {
    tokens[idx] = token;
  } else {
    tokens.push(token);
  }
  await saveTokens(tokens);
}

export async function hasToken(chainId: number, address: string): Promise<boolean> {
  const tokens = await getTokens();
  return tokens.some((t) => t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase());
}

export async function removeToken(chainId: number, address: string): Promise<void> {
  const tokens = await getTokens();
  const filtered = tokens.filter(
    (t) => !(t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase()),
  );
  await saveTokens(filtered);
}

/** Get balance for a single ERC-20 token. */
export async function getTokenBalance(token: Token, owner: string): Promise<string> {
  const client = await getClient(token.chainId);
  const raw = await client.readContract({
    address: token.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner as `0x${string}`],
  });
  return formatUnits(raw as bigint, token.decimals);
}
