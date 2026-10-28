import { beforeEach, expect, test } from 'bun:test';
import { resetFakeChrome } from './helpers/fake-chrome';
import { getTokens, removeToken, saveToken, seedDefaultTokensIfNeeded } from '../src/lib/token-manager';
import { getItem, setItem, STORAGE_KEYS } from '../src/lib/storage';
import { DEFAULT_TOKENS } from '../src/lib/default-tokens';
import { PRESET_NETWORKS } from '../src/types/network';
import type { Token } from '../src/types/token';
import { getAddress } from 'viem';

beforeEach(resetFakeChrome);

test('a fresh wallet includes the desktop default tokens with chain-specific metadata', async () => {
  const tokens = await getTokens();
  expect(tokens).toHaveLength(39);
  expect(new Set(tokens.map((token) => token.chainId)).size).toBe(15);
  expect(tokens.find((token) => token.chainId === 1 && token.symbol === 'USDT')).toMatchObject({
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, isCustom: false,
  });
  expect(tokens.find((token) => token.chainId === 56 && token.symbol === 'USDT')).toMatchObject({
    address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18,
  });
  expect(tokens.find((token) => token.chainId === 888 && token.symbol === 'wanBTC')).toMatchObject({
    address: '0x50c439B6d602297252505a6799d84eA5928bCFb6', decimals: 8,
  });
});

test('default metadata has valid addresses, unique chain/address pairs, logos, and configured networks', async () => {
  const keys = DEFAULT_TOKENS.map((token) => `${token.chainId}:${token.address.toLowerCase()}`);
  expect(new Set(keys).size).toBe(DEFAULT_TOKENS.length);
  for (const token of DEFAULT_TOKENS) {
    expect(token.address).toBe(getAddress(token.address));
    expect(token.decimals).toBeGreaterThanOrEqual(0);
    expect(token.decimals).toBeLessThanOrEqual(18);
    expect(token.logoUrl).toMatch(/^token-logos\//);
    expect(await Bun.file(`${import.meta.dir}/../public/${token.logoUrl}`).exists()).toBe(true);
    expect(PRESET_NETWORKS.some((network) => network.chainId === token.chainId)).toBe(true);
  }
});

test('upgrades keep custom metadata and do not duplicate an existing default address', async () => {
  const existing: Token = {
    chainId: 1, address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    symbol: 'My USDT', decimals: 6, name: 'My token', isCustom: true,
  };
  await setItem(STORAGE_KEYS.TOKENS, [existing]);
  const tokens = await getTokens();
  expect(tokens).toHaveLength(39);
  expect(tokens.filter((token) => token.chainId === 1 && token.address.toLowerCase() === existing.address)).toEqual([existing]);
  await removeToken(1, existing.address.toUpperCase());
  await seedDefaultTokensIfNeeded();
  expect(await getTokens()).toHaveLength(38);
});

test('deleted defaults stay deleted while newly shipped defaults are seeded', async () => {
  const oldKeys = DEFAULT_TOKENS.filter((token) => token.chainId === 1)
    .map((token) => `${token.chainId}:${token.address.toLowerCase()}`);
  await setItem(STORAGE_KEYS.SEEDED_TOKEN_IDS, oldKeys);
  const tokens = await getTokens();
  expect(tokens).toHaveLength(36);
  expect(tokens.filter((token) => token.chainId === 1)).toEqual([]);
  expect(await getItem<string[]>(STORAGE_KEYS.SEEDED_TOKEN_IDS)).toHaveLength(39);
});

test('concurrent seeding, additions, and removals keep each user change', async () => {
  const custom: Token = {
    chainId: 1, address: '0x0000000000000000000000000000000000000002', symbol: 'CUSTOM', decimals: 9, isCustom: true,
  };
  const removed = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  await Promise.all([
    seedDefaultTokensIfNeeded(), getTokens(), saveToken(custom), removeToken(1, removed),
  ]);
  await seedDefaultTokensIfNeeded();
  const tokens = await getTokens();
  expect(tokens).toHaveLength(39);
  expect(tokens.filter((token) => token.chainId === 1 && token.address.toLowerCase() === removed.toLowerCase())).toEqual([]);
  expect(tokens.filter((token) => token.isCustom)).toEqual([custom]);
  expect(new Set(tokens.map((token) => `${token.chainId}:${token.address.toLowerCase()}`)).size).toBe(39);
});
