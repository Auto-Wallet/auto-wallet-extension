import { test, expect, describe } from 'bun:test';
import {
  siteOrigin,
  addSite,
  removeSite,
  isConnected,
  legacyOriginsToSeed,
  type ConnectedSite,
} from '../src/lib/connected-sites.core';

describe('siteOrigin', () => {
  test('reduces http(s) URLs to their origin', () => {
    expect(siteOrigin('https://app.uniswap.org/swap?x=1')).toBe('https://app.uniswap.org');
    expect(siteOrigin('http://localhost:3000/')).toBe('http://localhost:3000');
  });

  test('returns null for anything that is not a web origin', () => {
    for (const v of ['Auto Wallet', 'Auto Wallet Swap · Approve', 'chrome-extension://abc', 'file:///x', '', 'javascript:alert(1)']) {
      expect(siteOrigin(v)).toBeNull();
    }
  });
});

describe('addSite / removeSite / isConnected', () => {
  test('adding twice keeps one entry and the first connect time', () => {
    let list: ConnectedSite[] = [];
    list = addSite(list, 'https://a.example', 100);
    list = addSite(list, 'https://a.example/path', 200);
    expect(list).toEqual([{ origin: 'https://a.example', connectedAt: 100 }]);
  });

  test('connection is per exact origin', () => {
    const list = addSite([], 'https://a.example', 1);
    expect(isConnected(list, 'https://a.example')).toBe(true);
    expect(isConnected(list, 'https://a.example.evil.com')).toBe(false);
    expect(isConnected(list, 'http://a.example')).toBe(false);
    expect(isConnected(list, 'https://sub.a.example')).toBe(false);
  });

  test('remove drops only that origin', () => {
    let list = addSite(addSite([], 'https://a.example', 1), 'https://b.example', 2);
    list = removeSite(list, 'https://a.example');
    expect(list).toEqual([{ origin: 'https://b.example', connectedAt: 2 }]);
  });

  test('adding a non-web origin throws', () => {
    expect(() => addSite([], 'Auto Wallet', 1)).toThrow();
  });
});

describe('legacyOriginsToSeed', () => {
  test('collects unique web origins from whitelist rules and tx history', () => {
    const rules = [
      { origin: 'https://app.uniswap.org' },
      { origin: null },
      { origin: 'https://app.uniswap.org/' },
    ];
    const log = [
      { origin: 'https://bot.example/run' },
      { origin: 'Auto Wallet' },
      { origin: 'Auto Wallet Swap · Approve' },
      { origin: 'https://app.uniswap.org' },
    ];
    expect(legacyOriginsToSeed(rules, log).sort()).toEqual(['https://app.uniswap.org', 'https://bot.example']);
  });

  test('nothing to seed → empty list', () => {
    expect(legacyOriginsToSeed([], [])).toEqual([]);
  });
});
