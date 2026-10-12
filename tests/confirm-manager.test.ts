import { test, expect, beforeEach } from 'bun:test';
import { fake, resetFakeChrome, dispatchRuntimeMessage, extensionSender } from './helpers/fake-chrome';
import { MSG_SOURCE } from '../src/types/messages';
import type { WhitelistRule } from '../src/types/whitelist';

const { requestUserConfirmation } = await import('../src/background/confirm-manager');

const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  await resetFakeChrome();
});

function respond(requestId: string, extra: Record<string, unknown>) {
  return dispatchRuntimeMessage(
    { source: MSG_SOURCE, type: 'confirm_response', requestId, ...extra },
    extensionSender(`confirm.html?id=${requestId}`),
  );
}

async function openRequest(id: string, method: string, origin = 'https://dapp.example') {
  const pending = requestUserConfirmation({ id, method, origin, params: [] });
  await new Promise((r) => setTimeout(r, 0));
  // Wrapped so `await openRequest()` doesn't wait for the confirmation itself.
  return { pending };
}

function storedRules(): WhitelistRule[] {
  return (fake.chrome.storage.local._dump().whitelist_rules as WhitelistRule[] | undefined) ?? [];
}

test('"Trust this site" adds a rule for the request origin that expires after the chosen time', async () => {
  const before = Date.now();
  const { pending } = await openRequest('t-1', 'eth_sendTransaction', 'https://dapp.example');
  // A forged origin in the message must be ignored in favour of the request's own.
  await respond('t-1', { approved: true, trustDurationMs: HOUR, origin: 'https://evil.example' });
  expect((await pending).approved).toBe(true);
  await new Promise((r) => setTimeout(r, 0));

  const rules = storedRules();
  expect(rules.length).toBe(1);
  expect(rules[0]!.origin).toBe('https://dapp.example');
  expect(rules[0]!.expiresAt! - rules[0]!.createdAt).toBe(HOUR);
  expect(rules[0]!.createdAt).toBeGreaterThanOrEqual(before);
});

test('no trust duration → no rule', async () => {
  const { pending } = await openRequest('t-2', 'personal_sign');
  await respond('t-2', { approved: true });
  await pending;
  await new Promise((r) => setTimeout(r, 0));
  expect(storedRules()).toEqual([]);
});

test('unsupported duration (e.g. forever) → request approved but no rule', async () => {
  const { pending } = await openRequest('t-3', 'personal_sign');
  await respond('t-3', { approved: true, trustDurationMs: Number.MAX_SAFE_INTEGER });
  expect((await pending).approved).toBe(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(storedRules()).toEqual([]);
});

test('trust is ignored for requests that are not transactions or signatures', async () => {
  for (const [id, method] of [['t-4', 'eth_requestAccounts'], ['t-5', 'wallet_addEthereumChain'], ['t-6', 'wallet_watchAsset']] as const) {
    const { pending } = await openRequest(id, method);
    await respond(id, { approved: true, trustDurationMs: HOUR });
    await pending;
  }
  await new Promise((r) => setTimeout(r, 0));
  expect(storedRules()).toEqual([]);
});

test('rejected request never adds a rule', async () => {
  const { pending } = await openRequest('t-7', 'eth_sendTransaction');
  await respond('t-7', { approved: false, trustDurationMs: HOUR });
  expect((await pending).approved).toBe(false);
  await new Promise((r) => setTimeout(r, 0));
  expect(storedRules()).toEqual([]);
});

test('page is told when its request no longer exists (e.g. wallet restarted)', async () => {
  const { pending: live } = await openRequest('t-8', 'personal_sign');
  expect(await respond('t-8', { approved: true })).toEqual({ ok: true });
  await live;
  expect(await respond('gone-id', { approved: true })).toEqual({ ok: false, error: 'expired' });
});
