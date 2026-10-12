import { test, expect, beforeEach } from 'bun:test';
import {
  fake,
  resetFakeChrome,
  dispatchRuntimeMessage,
  extensionSender,
  pageSender,
} from './helpers/fake-chrome';
import { MSG_SOURCE } from '../src/types/messages';

await import('../src/background/index');
const { requestUserConfirmation } = await import('../src/background/confirm-manager');
const { requestUnlock } = await import('../src/background/unlock-manager');

beforeEach(async () => {
  await resetFakeChrome();
});

function popupRequest(action: string, payload?: unknown) {
  return { source: MSG_SOURCE, id: 'req-1', type: 'popup_request', action, payload };
}

const RULE = {
  id: 'evil-rule', label: 'evil', enabled: true, origin: 'https://evil.example',
  contractAddress: null, methodSig: null, maxValueEth: null, maxGasLimit: null,
  chainId: null, createdAt: 0,
};

test('popup_request from a web page is ignored', async () => {
  const res = await dispatchRuntimeMessage(popupRequest('addRule', RULE), pageSender('https://evil.example/'));
  expect(res).toBeUndefined();
  expect(fake.chrome.storage.local._dump().whitelist_rules).toBeUndefined();
});

test('popup_request from our own page is handled', async () => {
  const res = await dispatchRuntimeMessage(popupRequest('addRule', RULE), extensionSender('popup.html'));
  expect(res.type).toBe('popup_response');
  expect(res.error).toBeUndefined();
  expect(fake.chrome.storage.local._dump().whitelist_rules).toEqual([RULE]);
});

test('confirm_response only counts when it comes from confirm.html', async () => {
  let settled: { approved: boolean } | null = null;
  const pending = requestUserConfirmation({ id: 'c-1', method: 'personal_sign', origin: 'https://dapp.example', params: [] })
    .then((r) => { settled = r; return r; });
  await new Promise((r) => setTimeout(r, 0));

  const forged = { source: MSG_SOURCE, type: 'confirm_response', requestId: 'c-1', approved: true };
  await dispatchRuntimeMessage(forged, pageSender('https://evil.example/'));
  await dispatchRuntimeMessage(forged, extensionSender('popup.html'));
  await new Promise((r) => setTimeout(r, 0));
  expect(settled).toBeNull();

  await dispatchRuntimeMessage(forged, extensionSender('confirm.html?id=c-1'));
  expect((await pending).approved).toBe(true);
});

test('unlock_response only counts when it comes from unlock.html', async () => {
  let settled: boolean | null = null;
  const pending = requestUnlock('https://dapp.example').then((r) => { settled = r; return r; });
  await new Promise((r) => setTimeout(r, 0));

  const forged = { source: MSG_SOURCE, type: 'unlock_response', success: true };
  await dispatchRuntimeMessage(forged, pageSender('https://evil.example/'));
  await new Promise((r) => setTimeout(r, 0));
  expect(settled).toBeNull();

  await dispatchRuntimeMessage(forged, extensionSender('unlock.html?origin=x'));
  expect(await pending).toBe(true);
});
