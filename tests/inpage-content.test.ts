import { test, expect, afterAll } from 'bun:test';
import { fake, dispatchRuntimeMessage, EXT_ID } from './helpers/fake-chrome';
import { MSG_SOURCE } from '../src/types/messages';

// Minimal page `window`: an EventTarget whose postMessage delivers a
// MessageEvent-like event with `source === window`, like a real page.
class FakeWindow extends EventTarget {
  location = { href: 'https://dapp.example/app', origin: 'https://dapp.example' };
  ethereum: unknown = undefined;
  posted: any[] = [];
  postMessage(data: unknown) {
    const copy = structuredClone(data);
    this.posted.push(copy);
    queueMicrotask(() => {
      const ev = new Event('message');
      Object.defineProperty(ev, 'data', { value: copy });
      Object.defineProperty(ev, 'source', { value: this });
      this.dispatchEvent(ev);
    });
  }
}

const g = globalThis as any;
const win = new FakeWindow();
const prevWindow = g.window;
g.window = win;
afterAll(async () => {
  // inpage.ts reads window.ethereum from a 100 ms startup timer; let it fire
  // before the page window goes away.
  await new Promise((r) => setTimeout(r, 150));
  g.window = prevWindow;
});

// Background stand-in for the content script's runtime messages.
const backgroundCalls: string[] = [];
fake.state.onRuntimeSend = (msg: any) => {
  backgroundCalls.push(msg.method);
  const result = msg.method === 'eth_accounts' ? ['0xconnected'] : null;
  return { source: MSG_SOURCE, id: 'r', type: 'rpc_response', requestId: msg.id, result };
};

await import('../src/content/index');
await import('../src/content/inpage');
const provider = g.window.autoWallet;

const tick = () => new Promise((r) => setTimeout(r, 0));

test('switching chain fires chainChanged once, from the background broadcast only', async () => {
  const seen: string[] = [];
  provider.on('chainChanged', (id: string) => seen.push(id));

  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
  // The background broadcasts chainChanged to every tab after a switch.
  await dispatchRuntimeMessage(
    { source: MSG_SOURCE, type: 'event', eventName: 'chainChanged', payload: '0x89' },
    { id: EXT_ID },
  );
  await tick();
  await tick();

  expect(seen).toEqual(['0x89']);
});

test('accountsChanged: the content script asks eth_accounts for its own origin instead of trusting the broadcast', async () => {
  const seen: unknown[] = [];
  provider.on('accountsChanged', (a: unknown) => seen.push(a));
  backgroundCalls.length = 0;

  await dispatchRuntimeMessage(
    { source: MSG_SOURCE, type: 'event', eventName: 'accountsChanged', payload: null },
    { id: EXT_ID },
  );
  await tick();
  await tick();
  await tick();

  expect(backgroundCalls).toEqual(['eth_accounts']);
  expect(seen).toEqual([['0xconnected']]);
});
