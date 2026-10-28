import type { Token } from '../types/token';
import { getItem, setItem, updateItem, STORAGE_KEYS } from './storage';
import { getClient } from './network-manager';
import { erc20Abi, formatUnits, getAddress } from 'viem';
import { DEFAULT_TOKENS } from './default-tokens';

// --- Storage ---

export async function getTokens(): Promise<Token[]> {
  await seedDefaultTokensIfNeeded();
  return (await getItem<Token[]>(STORAGE_KEYS.TOKENS)) ?? [];
}

function updateTokens(change: (tokens: Token[]) => Token[]): Promise<Token[]> {
  return updateItem<Token[]>(STORAGE_KEYS.TOKENS, (tokens) => change(tokens ?? []));
}

function sameToken(t: Token, chainId: number, address: string): boolean {
  return t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase();
}

// --- Public API ---

function tokenKey(token: Token): string {
  return `${token.chainId}:${token.address.toLowerCase()}`;
}

let seeding: Promise<void> | null = null;

/** Seed new defaults once. Existing entries win, and deleted defaults stay deleted. */
export function seedDefaultTokensIfNeeded(): Promise<void> {
  if (seeding) return seeding;
  seeding = seedDefaultTokens().finally(() => { seeding = null; });
  return seeding;
}

async function seedDefaultTokens(): Promise<void> {
  const seeded = new Set((await getItem<string[]>(STORAGE_KEYS.SEEDED_TOKEN_IDS)) ?? []);
  const pending = DEFAULT_TOKENS.filter((token) => !seeded.has(tokenKey(token)));
  if (pending.length === 0) return;

  // Share the add/remove queue so seeding cannot overwrite a user edit.
  await updateTokens((tokens) => {
    const existing = new Set(tokens.map(tokenKey));
    return [...tokens, ...pending.filter((token) => !existing.has(tokenKey(token)))];
  });
  // Record every offered default, including ones the user had already added.
  // Write after the list so an interrupted seed can retry without losing tokens.
  await setItem(STORAGE_KEYS.SEEDED_TOKEN_IDS, [...seeded, ...pending.map(tokenKey)]);
}

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
  await seedDefaultTokensIfNeeded();
  await updateTokens((tokens) =>
    tokens.some((t) => sameToken(t, token.chainId, token.address))
      ? tokens.map((t) => (sameToken(t, token.chainId, token.address) ? token : t))
      : [...tokens, token]);
}

export async function hasToken(chainId: number, address: string): Promise<boolean> {
  const tokens = await getTokens();
  return tokens.some((t) => t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase());
}

export async function removeToken(chainId: number, address: string): Promise<void> {
  await seedDefaultTokensIfNeeded();
  await updateTokens((tokens) => tokens.filter((t) => !sameToken(t, chainId, address)));
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
