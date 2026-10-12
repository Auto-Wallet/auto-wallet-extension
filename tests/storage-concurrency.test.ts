import { test, expect, beforeEach, describe } from 'bun:test';
import { resetFakeChrome } from './helpers/fake-chrome';
import type { WhitelistRule } from '../src/types/whitelist';
import type { TxLogEntry } from '../src/lib/tx-logger';

const storage = await import('../src/lib/storage');
const connectedSites = await import('../src/lib/connected-sites');
const whitelist = await import('../src/lib/whitelist');
const txLogger = await import('../src/lib/tx-logger');
const tokenManager = await import('../src/lib/token-manager');
const networkManager = await import('../src/lib/network-manager');
const { handlePopupAction } = await import('../src/background/popup-handler');

const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';

function rule(id: string): WhitelistRule {
  return {
    id, label: id, enabled: true, origin: 'a.example', contractAddress: null, methodSig: null,
    maxValueEth: null, maxGasLimit: null, chainId: null, createdAt: 1,
  };
}

function logEntry(id: string): TxLogEntry {
  return {
    id, timestamp: 1, chainId: 1, from: '0x1', to: '0x2', value: '0', origin: 'x',
    autoSigned: false, status: 'pending', hash: `0x${id}`,
  } as TxLogEntry;
}

beforeEach(async () => {
  await resetFakeChrome();
  connectedSites.resetSeedingForTests();
});

describe('updateItem', () => {
  test('changes to one key run one after another, each seeing the last result', async () => {
    await Promise.all(Array.from({ length: 20 }, () =>
      storage.updateItem<number>('counter', (n) => (n ?? 0) + 1)));
    expect(await storage.getItem<number>('counter')).toBe(20);
  });

  test('a failing change reaches its caller and does not block the next one', async () => {
    const failing = storage.updateItem<number>('k', () => { throw new Error('boom'); });
    const next = storage.updateItem<number>('k', () => 7);
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe(7);
    expect(await storage.getItem<number>('k')).toBe(7);
  });
});

describe('connected sites (review P1)', () => {
  test('disconnecting A while B connects or disconnects keeps A disconnected', async () => {
    await connectedSites.connectSite(A);
    await connectedSites.connectSite(C);
    await Promise.all([connectedSites.disconnectSite(A), connectedSites.connectSite(B)]);
    await Promise.all([connectedSites.disconnectSite(C), connectedSites.disconnectSite(B)]);
    expect(await connectedSites.getConnectedSites()).toEqual([]);
  });
});

describe('same race in other lists', () => {
  test('auto-sign rules: a removed rule does not come back when another rule is added at once', async () => {
    await whitelist.addRule(rule('old'));
    await Promise.all([whitelist.removeRule('old'), whitelist.addRule(rule('new'))]);
    expect((await whitelist.getRules()).map((r) => r.id)).toEqual(['new']);
  });

  test('tx log: two status updates at once both stick', async () => {
    await txLogger.appendLog(logEntry('a'));
    await txLogger.appendLog(logEntry('b'));
    await Promise.all([
      txLogger.updateLogEntry('a', { status: 'confirmed' }),
      txLogger.updateLogEntry('b', { status: 'failed' }),
      txLogger.appendLog(logEntry('c')),
    ]);
    const byId = Object.fromEntries((await txLogger.getLog()).map((e) => [e.id, e.status]));
    expect(byId).toEqual({ a: 'confirmed', b: 'failed', c: 'pending' });
  });
});

describe('same race in tokens, networks and settings', () => {
  const token = (address: string) => ({ chainId: 1, address, symbol: 'T', decimals: 18, isCustom: true });
  const net = (chainId: number) => ({ chainId, name: `Net ${chainId}`, rpcUrl: 'https://rpc.example', symbol: 'N', decimals: 18 });

  test('tokens: adding one while removing another keeps both changes', async () => {
    await tokenManager.saveToken(token('0x0000000000000000000000000000000000000001'));
    await Promise.all([
      tokenManager.removeToken(1, '0x0000000000000000000000000000000000000001'),
      tokenManager.saveToken(token('0x0000000000000000000000000000000000000002')),
    ]);
    expect((await tokenManager.getTokens()).map((t) => t.address)).toEqual(['0x0000000000000000000000000000000000000002']);
  });

  test('networks: two networks added at once are both kept', async () => {
    await Promise.all([networkManager.addCustomNetwork(net(901)), networkManager.addCustomNetwork(net(902))]);
    const ids = (await networkManager.getAllNetworks()).map((n) => n.chainId);
    expect(ids).toContain(901);
    expect(ids).toContain(902);
  });

  test('networks: adding the same chain twice at once fails once instead of both succeeding', async () => {
    const results = await Promise.allSettled([networkManager.addCustomNetwork(net(903)), networkManager.addCustomNetwork(net(903))]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await networkManager.getAllNetworks()).filter((n) => n.chainId === 903).length).toBe(1);
  });

  test('settings: two changes saved at once both stick', async () => {
    await Promise.all([
      handlePopupAction('saveSettings', { autoLockMinutes: 60 }),
      handlePopupAction('saveSettings', { injectWindowEthereum: true }),
    ]);
    const s = (await handlePopupAction('getSettings', undefined)) as any;
    expect(s.autoLockMinutes).toBe(60);
    expect(s.injectWindowEthereum).toBe(true);
  });
});
