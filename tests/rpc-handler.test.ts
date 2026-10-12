import { test, expect, beforeEach, afterAll, describe } from 'bun:test';
import { encodeAbiParameters, toHex } from 'viem';
import {
  fake,
  resetFakeChrome,
  dispatchRuntimeMessage,
  extensionSender,
  pageSender,
} from './helpers/fake-chrome';
import { MSG_SOURCE } from '../src/types/messages';

await import('../src/background/index');
const keyManager = await import('../src/lib/key-manager');
const networkManager = await import('../src/lib/network-manager');
const connectedSites = await import('../src/lib/connected-sites');
const { handleRpcMethod } = await import('../src/background/rpc-handler');

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DAPP = 'https://dapp.example';
const TOKEN = '0x1111111111111111111111111111111111111111';

// --- Stub the JSON-RPC node so token reads work offline ---
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const answer = (req: any) => {
    let result: unknown = null;
    if (req.method === 'eth_chainId') result = '0x1';
    if (req.method === 'eth_call') {
      const selector = String(req.params[0].data).slice(0, 10);
      if (selector === '0x95d89b41') result = encodeAbiParameters([{ type: 'string' }], ['TKN']);
      if (selector === '0x06fdde03') result = encodeAbiParameters([{ type: 'string' }], ['Token']);
      if (selector === '0x313ce567') result = encodeAbiParameters([{ type: 'uint8' }], [6]);
    }
    return { jsonrpc: '2.0', id: req.id, result };
  };
  const payload = Array.isArray(body) ? body.map(answer) : answer(body);
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

/** Answer every confirm popup that opens with the given decision. */
function answerConfirms(approved: boolean, seen: string[] = []) {
  fake.state.onWindowCreated = async (win) => {
    const id = new URL(win.url).searchParams.get('id');
    if (!id) return;
    const stored = (await fake.chrome.storage.session.get(`confirm_${id}`))[`confirm_${id}`] as any;
    seen.push(stored.method);
    await dispatchRuntimeMessage(
      { source: MSG_SOURCE, type: 'confirm_response', requestId: id, approved },
      extensionSender(`confirm.html?id=${id}`),
    );
  };
  return seen;
}

async function expectRpcError(p: Promise<unknown>, code: number, msg?: RegExp) {
  try {
    await p;
  } catch (e: any) {
    expect(e.code).toBe(code);
    if (msg) expect(e.message).toMatch(msg);
    return;
  }
  throw new Error(`expected RPC error ${code}`);
}

const fg = pageSender(`${DAPP}/app`, { active: true });
const bg = pageSender(`${DAPP}/app`, { active: false });

beforeEach(async () => {
  await keyManager.lock();
  await resetFakeChrome();
  connectedSites.resetSeedingForTests();
  await networkManager.seedPresetsIfNeeded();
  await networkManager.switchNetwork(1);
  await keyManager.importPrivateKey(PK, 'pw-12345678');
});

describe('site connection', () => {
  test('eth_accounts returns nothing to a site that never connected', async () => {
    expect(await handleRpcMethod('eth_accounts', [], DAPP, fg)).toEqual([]);
  });

  test('eth_requestAccounts asks the user, then remembers the site', async () => {
    const seen = answerConfirms(true);
    expect(await handleRpcMethod('eth_requestAccounts', [], DAPP, fg)).toEqual([ADDR]);
    expect(seen).toEqual(['eth_requestAccounts']);
    expect(await connectedSites.isSiteConnected(DAPP)).toBe(true);

    // Second call: no new popup.
    expect(await handleRpcMethod('eth_requestAccounts', [], DAPP, fg)).toEqual([ADDR]);
    expect(await handleRpcMethod('eth_accounts', [], DAPP, fg)).toEqual([ADDR]);
    expect(seen).toEqual(['eth_requestAccounts']);
  });

  test('rejecting the connect prompt → 4001 and the site stays unconnected', async () => {
    answerConfirms(false);
    await expectRpcError(handleRpcMethod('eth_requestAccounts', [], DAPP, fg), 4001);
    expect(await connectedSites.isSiteConnected(DAPP)).toBe(false);
  });

  test('signing, switching chains and watchAsset need a connection (4100)', async () => {
    await expectRpcError(handleRpcMethod('personal_sign', ['0x68656c6c6f', ADDR], DAPP, fg), 4100);
    await expectRpcError(handleRpcMethod('eth_sendTransaction', [{ to: ADDR, value: '0x0' }], DAPP, fg), 4100);
    await expectRpcError(handleRpcMethod('wallet_switchEthereumChain', [{ chainId: '0x89' }], DAPP, fg), 4100);
    await expectRpcError(handleRpcMethod('wallet_watchAsset', { type: 'ERC20', options: { address: TOKEN } } as any, DAPP, fg), 4100);
  });

  test('wallet_requestPermissions / getPermissions / revokePermissions', async () => {
    expect(await handleRpcMethod('wallet_getPermissions', [], DAPP, fg)).toEqual([]);
    answerConfirms(true);
    const granted = await handleRpcMethod('wallet_requestPermissions', [{ eth_accounts: {} }], DAPP, fg) as any[];
    expect(granted.map((p) => p.parentCapability)).toEqual(['eth_accounts']);
    expect((await handleRpcMethod('wallet_getPermissions', [], DAPP, fg) as any[]).length).toBe(1);
    expect(await handleRpcMethod('wallet_revokePermissions', [{ eth_accounts: {} }], DAPP, fg)).toBeNull();
    expect(await handleRpcMethod('eth_accounts', [], DAPP, fg)).toEqual([]);
  });

  test('upgrade: sites from existing whitelist rules count as connected without a prompt', async () => {
    await fake.chrome.storage.local.set({
      whitelist_rules: [{ id: 'r', label: 'bot', enabled: true, origin: 'https://bot.example', contractAddress: null, methodSig: null, maxValueEth: null, maxGasLimit: null, chainId: null, createdAt: 0 }],
    });
    expect(await handleRpcMethod('eth_accounts', [], 'https://bot.example', fg)).toEqual([ADDR]);
  });

  test('accountsChanged broadcasts never carry the address', async () => {
    fake.state.tabs = [{ id: 7, windowId: 1, active: true }];
    await dispatchRuntimeMessage(
      { source: MSG_SOURCE, id: 'x', type: 'popup_request', action: 'lock' },
      extensionSender('popup.html'),
    );
    await new Promise((r) => setTimeout(r, 0));
    const events = fake.state.sentTabMessages.filter((m) => m.message.eventName === 'accountsChanged');
    expect(events.length).toBe(1);
    expect(JSON.stringify(events[0]!.message)).not.toContain(ADDR.slice(2, 12).toLowerCase());
    expect(JSON.stringify(events[0]!.message)).not.toContain(ADDR.slice(2, 12));
  });
});

describe('connected site', () => {
  beforeEach(async () => {
    await connectedSites.connectSite(DAPP);
  });

  test('eth_sign is refused (4200) — blind hash signing is a phishing tool', async () => {
    await expectRpcError(handleRpcMethod('eth_sign', [ADDR, '0x' + 'ab'.repeat(32)], DAPP, fg), 4200, /personal_sign/);
  });

  test('typed data for another chain is refused', async () => {
    const typed = {
      types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], M: [{ name: 'a', type: 'uint256' }] },
      primaryType: 'M', domain: { chainId: 137 }, message: { a: 1 },
    };
    await expectRpcError(handleRpcMethod('eth_signTypedData_v4', [ADDR, JSON.stringify(typed)], DAPP, fg), -32602, /active chain/);
  });

  test('typed data for the active chain can be signed after approval', async () => {
    answerConfirms(true);
    const typed = {
      types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], M: [{ name: 'a', type: 'uint256' }] },
      primaryType: 'M', domain: { chainId: 1 }, message: { a: 1 },
    };
    const sig = await handleRpcMethod('eth_signTypedData_v4', [ADDR, JSON.stringify(typed)], DAPP, fg);
    expect(String(sig)).toMatch(/^0x[0-9a-f]{130}$/);
  });

  test('switch chain from a background tab is refused and changes nothing', async () => {
    await expectRpcError(handleRpcMethod('wallet_switchEthereumChain', [{ chainId: '0x89' }], DAPP, bg), 4001, /tab/);
    expect(await networkManager.getActiveChainId()).toBe(1);
  });

  test('switch chain from the active tab of an unfocused window is refused (review P2)', async () => {
    // Window 2 is open behind the focused window 1; its active tab is not what the user sees.
    const unfocused = pageSender(`${DAPP}/app`, { active: true, windowId: 2 });
    await expectRpcError(handleRpcMethod('wallet_switchEthereumChain', [{ chainId: '0x89' }], DAPP, unfocused), 4001, /tab/);
    const params = [{ chainId: '0x89', chainName: 'Polygon', rpcUrls: ['https://polygon.drpc.org'], nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 } }];
    await expectRpcError(handleRpcMethod('wallet_addEthereumChain', params, DAPP, unfocused), 4001);
    expect(await networkManager.getActiveChainId()).toBe(1);
  });

  test('switch chain from a sender without a tab is refused', async () => {
    const noTab = { id: 'test-ext-id', url: `${DAPP}/app`, origin: DAPP } as chrome.runtime.MessageSender;
    await expectRpcError(handleRpcMethod('wallet_switchEthereumChain', [{ chainId: '0x89' }], DAPP, noTab), 4001);
    expect(await networkManager.getActiveChainId()).toBe(1);
  });

  test('switch chain from the foreground tab switches and emits chainChanged once', async () => {
    fake.state.tabs = [{ id: 7, windowId: 1, active: true }];
    expect(await handleRpcMethod('wallet_switchEthereumChain', [{ chainId: '0x89' }], DAPP, fg)).toBeNull();
    expect(await networkManager.getActiveChainId()).toBe(137);
    await new Promise((r) => setTimeout(r, 0));
    const events = fake.state.sentTabMessages.filter((m) => m.message.eventName === 'chainChanged');
    expect(events.map((e) => e.message.payload)).toEqual(['0x89']);
  });

  test('switch to the chain already active does not emit chainChanged', async () => {
    fake.state.tabs = [{ id: 7, windowId: 1, active: true }];
    await handleRpcMethod('wallet_switchEthereumChain', [{ chainId: '0x1' }], DAPP, fg);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.state.sentTabMessages.filter((m) => m.message.eventName === 'chainChanged')).toEqual([]);
  });

  test('switch chain with a malformed chainId → -32602', async () => {
    await expectRpcError(handleRpcMethod('wallet_switchEthereumChain', [{ chainId: '137' }], DAPP, fg), -32602);
    await expectRpcError(handleRpcMethod('wallet_switchEthereumChain', [], DAPP, fg), -32602);
  });

  test('addEthereumChain for a known chain switches and emits chainChanged', async () => {
    fake.state.tabs = [{ id: 7, windowId: 1, active: true }];
    const params = [{ chainId: '0x89', chainName: 'Polygon', rpcUrls: ['https://polygon.drpc.org'], nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 } }];
    expect(await handleRpcMethod('wallet_addEthereumChain', params, DAPP, fg)).toBeNull();
    expect(await networkManager.getActiveChainId()).toBe(137);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.state.sentTabMessages.filter((m) => m.message.eventName === 'chainChanged').map((e) => e.message.payload)).toEqual(['0x89']);
  });

  test('addEthereumChain from a background tab is refused', async () => {
    const params = [{ chainId: '0x89', chainName: 'Polygon', rpcUrls: ['https://polygon.drpc.org'], nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 } }];
    await expectRpcError(handleRpcMethod('wallet_addEthereumChain', params, DAPP, bg), 4001);
    expect(await networkManager.getActiveChainId()).toBe(1);
  });

  test('watchAsset asks the user and stores the on-chain symbol/decimals', async () => {
    const seen = answerConfirms(true);
    const ok = await handleRpcMethod('wallet_watchAsset', { type: 'ERC20', options: { address: TOKEN, symbol: 'FAKE', decimals: 18 } } as any, DAPP, fg);
    expect(ok).toBe(true);
    expect(seen).toEqual(['wallet_watchAsset']);
    const tokens = fake.chrome.storage.local._dump().tokens as any[];
    expect(tokens.map((t) => [t.chainId, t.address.toLowerCase(), t.symbol, t.decimals])).toEqual([[1, TOKEN, 'TKN', 6]]);
  });

  test('watchAsset rejected → 4001 and nothing stored', async () => {
    answerConfirms(false);
    await expectRpcError(handleRpcMethod('wallet_watchAsset', { type: 'ERC20', options: { address: TOKEN } } as any, DAPP, fg), 4001);
    expect(fake.chrome.storage.local._dump().tokens).toBeUndefined();
  });

  test('internal extension pages (swap) are not subject to site connection', async () => {
    await connectedSites.disconnectSite(DAPP);
    // Rejected confirm proves we got past the connection gate to the popup.
    answerConfirms(false);
    await expectRpcError(
      handleRpcMethod('personal_sign', [toHex('hi'), ADDR], 'Auto Wallet Swap', extensionSender('swap.html')),
      4001,
    );
  });
});

describe('connected sites in settings', () => {
  function popup(action: string, payload?: unknown) {
    return dispatchRuntimeMessage(
      { source: MSG_SOURCE, id: 'p', type: 'popup_request', action, payload },
      extensionSender('popup.html'),
    ).then((res) => {
      if (res.error) throw new Error(res.error);
      return res.result;
    });
  }

  test('lists connected sites and disconnecting one cuts its access and tells tabs', async () => {
    await connectedSites.connectSite(DAPP);
    await connectedSites.connectSite('https://other.example');
    const sites = (await popup('getConnectedSites')) as { origin: string }[];
    expect(sites.map((s) => s.origin).sort()).toEqual([DAPP, 'https://other.example']);

    fake.state.tabs = [{ id: 7, url: `${DAPP}/app`, active: true }] as any;
    fake.state.sentTabMessages.length = 0;
    await popup('disconnectSite', { origin: DAPP });

    expect(await handleRpcMethod('eth_accounts', [], DAPP, fg)).toEqual([]);
    expect(await handleRpcMethod('eth_accounts', [], 'https://other.example', fg)).toEqual([ADDR]);
    expect(fake.state.sentTabMessages.map((m: any) => m.message.eventName)).toEqual(['accountsChanged']);
  });

  test('disconnect refuses something that is not a web origin', async () => {
    await expect(popup('disconnectSite', { origin: 'not a url' })).rejects.toThrow(/origin/i);
  });
});
