import { test, expect, beforeEach, afterAll } from 'bun:test';
import { fake, resetFakeChrome } from './helpers/fake-chrome';

const networkManager = await import('../src/lib/network-manager');
const { checkPendingTxs, TX_RESUME_ALARM } = await import('../src/background/tx-poller');
const { closeOrphanedPopups } = await import('../src/background/orphan-popups');

const MINED = '0x' + 'aa'.repeat(32);
const STILL_PENDING = '0x' + 'bb'.repeat(32);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const answer = (req: any) => {
    let result: unknown = null;
    if (req.method === 'eth_chainId') result = '0x1';
    if (req.method === 'eth_blockNumber') result = '0x10';
    if (req.method === 'eth_getTransactionReceipt' && req.params[0] === MINED) {
      result = {
        blockHash: '0x' + '11'.repeat(32), blockNumber: '0x10', contractAddress: null,
        cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', from: '0x' + '22'.repeat(20),
        gasUsed: '0x5208', logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x1',
        to: '0x' + '33'.repeat(20), transactionHash: MINED, transactionIndex: '0x0', type: '0x2',
      };
    }
    return { jsonrpc: '2.0', id: req.id, result };
  };
  const payload = Array.isArray(body) ? body.map(answer) : answer(body);
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

function row(id: string, hash: string, ageMs = 60_000) {
  return {
    id, timestamp: Date.now() - ageMs, chainId: 1, from: '0x' + '22'.repeat(20), to: '0x' + '33'.repeat(20),
    value: '0', hash, origin: 'https://dapp.example', autoSigned: true, status: 'pending',
  };
}

beforeEach(async () => {
  await resetFakeChrome();
  await networkManager.seedPresetsIfNeeded();
});

test('a pending row whose receipt exists is finalized and notified after a restart', async () => {
  await fake.chrome.storage.local.set({ tx_log: [row('mined', MINED), row('waiting', STILL_PENDING)] });

  await checkPendingTxs();

  const log = fake.chrome.storage.local._dump().tx_log as any[];
  const mined = log.find((e) => e.id === 'mined');
  expect(mined.status).toBe('confirmed');
  expect(mined.gasUsed).toBe('21000');
  expect(mined.feeWei).toBe((21000n * 1_000_000_000n).toString());
  expect(log.find((e) => e.id === 'waiting').status).toBe('pending');
  expect(fake.state.notifications.map((n) => n.id)).toEqual([`tx-${MINED}`]);
  // Still one pending row → keep checking periodically.
  expect(fake.state.alarms.has(TX_RESUME_ALARM)).toBe(true);
});

test('after a speed-up, an original tx that mined first is found after a restart (review P2)', async () => {
  // Row as replacePendingTx leaves it: `hash` = replacement (never mined), `prevHash` = original.
  await fake.chrome.storage.local.set({ tx_log: [{ ...row('sped', STILL_PENDING), prevHash: MINED, replacementKind: 'speedup' }] });

  await checkPendingTxs();

  const entry = (fake.chrome.storage.local._dump().tx_log as any[])[0];
  expect(entry.status).toBe('confirmed');
  expect(entry.hash).toBe(MINED); // the row now points at the tx that landed
  expect(fake.state.notifications.map((n) => n.id)).toEqual([`tx-${MINED}`]);
  expect(fake.state.alarms.has(TX_RESUME_ALARM)).toBe(false);
});

test('after two speed-ups, the first tx is still checked', async () => {
  const middle = '0x' + 'cc'.repeat(32);
  await fake.chrome.storage.local.set({
    tx_log: [{ ...row('twice', STILL_PENDING), prevHash: middle, replacedHashes: [MINED, middle], replacementKind: 'speedup' }],
  });
  await checkPendingTxs();
  const entry = (fake.chrome.storage.local._dump().tx_log as any[])[0];
  expect(entry.status).toBe('confirmed');
  expect(entry.hash).toBe(MINED);
});

test('cancel failed: the original transfer mined first, so the row is not shown as cancelled', async () => {
  // Cancel broadcast (hash = cancel tx, never mined), worker restarted, original (MINED) landed.
  await fake.chrome.storage.local.set({
    tx_log: [{ ...row('c', STILL_PENDING), value: '1000', prevHash: MINED, replacedHashes: [MINED], cancelHashes: [STILL_PENDING], replacementKind: 'cancel' }],
  });
  await checkPendingTxs();
  const entry = (fake.chrome.storage.local._dump().tx_log as any[])[0];
  expect(entry.status).toBe('confirmed');
  expect(entry.hash).toBe(MINED);
  expect(entry.replacementKind).toBeUndefined();
});

test('cancel succeeded: the cancel tx mined, so the row stays a cancel', async () => {
  await fake.chrome.storage.local.set({
    tx_log: [{ ...row('c', MINED), prevHash: STILL_PENDING, replacedHashes: [STILL_PENDING], cancelHashes: [MINED], replacementKind: 'cancel' }],
  });
  await checkPendingTxs();
  const entry = (fake.chrome.storage.local._dump().tx_log as any[])[0];
  expect(entry.status).toBe('confirmed');
  expect(entry.replacementKind).toBe('cancel');
});

test('alarm is cleared once nothing is left to check', async () => {
  fake.state.alarms.set(TX_RESUME_ALARM, { periodInMinutes: 1 });
  await fake.chrome.storage.local.set({ tx_log: [row('mined', MINED)] });
  await checkPendingTxs();
  expect(fake.state.alarms.has(TX_RESUME_ALARM)).toBe(false);
});

test('rows older than a day are not polled', async () => {
  await fake.chrome.storage.local.set({ tx_log: [row('old', MINED, 25 * 60 * 60 * 1000)] });
  await checkPendingTxs();
  const log = fake.chrome.storage.local._dump().tx_log as any[];
  expect(log[0].status).toBe('pending');
  expect(fake.state.notifications).toEqual([]);
});

test('confirm / unlock popups left by a dead worker are closed on startup', async () => {
  fake.state.contexts = [
    { contextType: 'TAB', documentUrl: 'chrome-extension://test-ext-id/confirm.html?id=1', windowId: 55 },
    { contextType: 'TAB', documentUrl: 'chrome-extension://test-ext-id/unlock.html?origin=x', windowId: 56 },
    { contextType: 'TAB', documentUrl: 'chrome-extension://test-ext-id/swap.html', windowId: 57 },
  ];
  await fake.chrome.storage.session.set({ confirm_1: { id: '1' }, confirm_1_simulation: {}, aw_session: { keep: true } });

  await closeOrphanedPopups(() => ({ requestIds: new Set(), windowIds: new Set() }));

  expect(fake.state.removedWindows.sort()).toEqual([55, 56]);
  expect(Object.keys(fake.chrome.storage.session._dump())).toEqual(['aw_session']);
});

test('popups and requests opened by the current worker are kept', async () => {
  fake.state.contexts = [
    { contextType: 'TAB', documentUrl: 'chrome-extension://test-ext-id/confirm.html?id=old', windowId: 60 },
    // Window id not recorded yet — matched by its request id instead.
    { contextType: 'TAB', documentUrl: 'chrome-extension://test-ext-id/confirm.html?id=new', windowId: 61 },
    { contextType: 'TAB', documentUrl: 'chrome-extension://test-ext-id/unlock.html?origin=x', windowId: 62 },
  ];
  await fake.chrome.storage.session.set({ confirm_old: {}, confirm_new: {}, confirm_new_simulation: {} });

  // The live set is read after the page list, as the real startup does.
  let reads = 0;
  await closeOrphanedPopups(() => { reads++; return { requestIds: new Set(['new']), windowIds: new Set([62]) }; });

  expect(reads).toBe(1);
  expect(fake.state.removedWindows).toEqual([60]);
  expect(Object.keys(fake.chrome.storage.session._dump()).sort()).toEqual(['confirm_new', 'confirm_new_simulation']);
});
