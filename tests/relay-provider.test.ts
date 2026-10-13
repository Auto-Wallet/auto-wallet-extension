import { afterEach, beforeEach, expect, test } from 'bun:test';
import { fake, resetFakeChrome, dispatchRuntimeMessage, extensionSender, pageSender } from './helpers/fake-chrome';
import { RelayProvider } from '../src/lib/swap/relay-provider';
import type { QuoteParams } from '../src/lib/swap/types';
import { MSG_SOURCE } from '../src/types/messages';

await import('../src/background/index');

const originalFetch = globalThis.fetch;
const globals = globalThis as typeof globalThis & { __RELAY_API_KEY__?: string };
const TEST_KEY = 'relay-test-key-not-a-real-secret';
function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: originalFetch.preconnect });
}
const params: QuoteParams = {
  fromChainId: 8453, toChainId: 42161,
  fromToken: { chainId: 8453, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18, logo: '' },
  toToken: { chainId: 42161, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18, logo: '' },
  fromAddress: '0x1111111111111111111111111111111111111111',
  toAddress: '0x2222222222222222222222222222222222222222',
  fromAmount: '0.001', slippage: 0.01,
};
const quoteResponse = {
  steps: [{ id: 'deposit', kind: 'transaction', requestId: 'test-request', items: [{ status: 'incomplete', data: { to: params.toAddress, value: '1000000000000000', data: '0x', chainId: 8453 } }] }],
  fees: {},
  details: { currencyOut: { amount: '990000000000000', amountFormatted: '0.00099', currency: { decimals: 18, symbol: 'ETH' } }, timeEstimate: 15 },
};

beforeEach(async () => {
  await resetFakeChrome();
  globals.__RELAY_API_KEY__ = TEST_KEY;
  fake.state.onRuntimeSend = (message) => dispatchRuntimeMessage(message, extensionSender('swap.html'));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globals.__RELAY_API_KEY__;
});

test('Relay quote carries the app key and returns the quoted amount through the background', async () => {
  let calls = 0;
  globalThis.fetch = mockFetch(async (input, init) => {
    calls++;
    expect(String(input)).toBe('https://api.relay.link/quote/v2');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-api-key')).toBe(TEST_KEY);
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      user: params.fromAddress, recipient: params.toAddress,
      originChainId: 8453, destinationChainId: 42161,
      amount: '1000000000000000', tradeType: 'EXACT_INPUT',
      slippageTolerance: '100', referrer: 'auto-wallet',
      appFees: [{ recipient: '0x7521EDa00E2Ce05aC4a9d8353d096CCB970d5188', fee: '10' }],
    });
    return Response.json(quoteResponse);
  });
  const quote = await new RelayProvider().getQuote(params);
  expect(quote.amountOutRaw).toBe('990000000000000');
  expect(quote.amountOutMinRaw).toBe('980100000000000');
  expect(calls).toBe(1);
});

test('Relay HTTP errors preserve the message and hide the key', async () => {
  globalThis.fetch = mockFetch(async () => Response.json({ message: `Invalid key ${TEST_KEY}` }, { status: 401 })) as typeof fetch;
  await expect(new RelayProvider().getQuote(params)).rejects.toThrow('Invalid key [redacted]');
});

test('An echoed key never returns to the swap UI', async () => {
  globalThis.fetch = mockFetch(async () => Response.json({ ...quoteResponse, diagnostic: TEST_KEY })) as typeof fetch;
  const quote = await new RelayProvider().getQuote(params);
  expect((quote.raw as { diagnostic: string }).diagnostic).toBe('[redacted]');
});

test('Chain metadata and status polling also carry the key through the background', async () => {
  const paths: string[] = [];
  globalThis.fetch = mockFetch(async (input, init) => {
    paths.push(String(input));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('x-api-key')).toBe(TEST_KEY);
    if (String(input).endsWith('/chains')) {
      return Response.json({ chains: [{ id: 8453, name: 'Base', vmType: 'evm', currency: { symbol: 'ETH', decimals: 18 } }] });
    }
    return Response.json({ status: 'success', inTxHashes: ['0xsource'], txHashes: ['0xdestination'] });
  });
  const provider = new RelayProvider();
  expect((await provider.loadChains()).map((chain) => chain.chainId)).toEqual([8453]);
  expect((await provider.loadTokensByChain()).get(8453)!.map((token) => token.symbol)).toEqual(['ETH']);
  const status = await provider.getStatus({ params, sourceHash: '0xsource', requestId: 'request/a?b&c' });
  expect(status.state).toBe('success');
  expect(status.destHash).toBe('0xdestination');
  expect(paths).toEqual([
    'https://api.relay.link/chains', 'https://api.relay.link/chains',
    'https://api.relay.link/intents/status/v3?requestId=request%2Fa%3Fb%26c',
  ]);
});

test('An unconfigured key stops the quote before any network call', async () => {
  delete globals.__RELAY_API_KEY__;
  let calls = 0;
  globalThis.fetch = mockFetch(async () => { calls++; return Response.json(quoteResponse); });
  await expect(new RelayProvider().getQuote(params)).rejects.toThrow('Relay API key is not configured');
  globals.__RELAY_API_KEY__ = '   ';
  await expect(new RelayProvider().getQuote(params)).rejects.toThrow('Relay API key is not configured');
  expect(calls).toBe(0);
});

test('Web pages and other extensions cannot make authenticated Relay requests', async () => {
  let calls = 0;
  globalThis.fetch = mockFetch(async () => { calls++; return Response.json(quoteResponse); });
  const request = { source: MSG_SOURCE, id: 'relay-1', type: 'popup_request', action: 'relayRequest', payload: { method: 'GET', path: '/chains' } };
  expect(await dispatchRuntimeMessage(request, pageSender('https://evil.example'))).toBeUndefined();
  expect(await dispatchRuntimeMessage(request, { id: 'other', url: 'chrome-extension://other/swap.html' })).toBeUndefined();
  expect(calls).toBe(0);
});

test('The Relay bridge rejects other hosts, paths, methods, and invalid bodies', async () => {
  let calls = 0;
  globalThis.fetch = mockFetch(async () => { calls++; return Response.json(quoteResponse); });
  for (const payload of [
    null,
    { method: 'GET', path: 'https://evil.example/chains' },
    { method: 'GET', path: '//evil.example/chains' },
    { method: 'GET', path: '/chains/../quote/v2' },
    { method: 'GET', path: '/intents/status/v3?requestId=foo&redirect=evil' },
    { method: 'DELETE', path: '/quote/v2', body: {} },
    { method: 'POST', path: '/quote/v2', body: [] },
    { method: 'POST', path: '/quote/v2' },
    { method: 'GET', path: '/chains', body: {} },
  ]) {
    const response = await dispatchRuntimeMessage({ source: MSG_SOURCE, id: 'relay-2', type: 'popup_request', action: 'relayRequest', payload }, extensionSender('swap.html'));
    expect(typeof response.error).toBe('string');
    expect(response.result).toBeUndefined();
  }
  expect(calls).toBe(0);
});

test('Plain text, empty HTTP errors, and network errors stay useful and hide the key', async () => {
  globalThis.fetch = mockFetch(async () => new Response(`Rate limit for ${TEST_KEY}`, { status: 429 })) as typeof fetch;
  await expect(new RelayProvider().getQuote(params)).rejects.toThrow('Relay /quote/v2 HTTP 429: Rate limit for [redacted]');
  globalThis.fetch = mockFetch(async () => new Response(null, { status: 503 })) as typeof fetch;
  await expect(new RelayProvider().getQuote(params)).rejects.toThrow('Relay /quote/v2 HTTP 503');
  globalThis.fetch = mockFetch(async () => { throw new Error(`Network failed for ${TEST_KEY}`); });
  await expect(new RelayProvider().getQuote(params)).rejects.toThrow('Network failed for [redacted]');
});
