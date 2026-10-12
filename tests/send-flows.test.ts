import { test, expect, beforeEach, afterAll, describe } from 'bun:test';
import { parseTransaction, decodeFunctionData, erc20Abi, keccak256, encodeAbiParameters } from 'viem';
import { fake, resetFakeChrome, dispatchRuntimeMessage, extensionSender, pageSender } from './helpers/fake-chrome';
import { MSG_SOURCE } from '../src/types/messages';

await import('../src/background/index');
const keyManager = await import('../src/lib/key-manager');
const networkManager = await import('../src/lib/network-manager');
const connectedSites = await import('../src/lib/connected-sites');
const { handleRpcMethod } = await import('../src/background/rpc-handler');

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TOKEN = '0x1111111111111111111111111111111111111111';
const DAPP = 'https://dapp.example';
const PENDING_NONCE = 9;

// --- JSON-RPC node stub: records raw txs, answers the reads viem needs ---
const rawTxs: `0x${string}`[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const answer = (req: any) => {
    let result: unknown = null;
    switch (req.method) {
      case 'eth_chainId': result = '0x1'; break;
      case 'eth_getTransactionCount': result = `0x${PENDING_NONCE.toString(16)}`; break;
      case 'eth_estimateGas': result = '0x5208'; break;
      case 'eth_gasPrice': result = '0x3b9aca00'; break;
      case 'eth_maxPriorityFeePerGas': result = '0x3b9aca00'; break;
      case 'eth_getBlockByNumber': result = { baseFeePerGas: null, number: '0x10', hash: '0x' + '11'.repeat(32), transactions: [] }; break;
      case 'eth_call': result = encodeAbiParameters([{ type: 'uint8' }], [6]); break;
      case 'eth_sendRawTransaction':
        rawTxs.push(req.params[0]);
        result = keccak256(req.params[0]);
        break;
      // Mine everything at once so receipt polls started by sends finish
      // inside this file instead of outliving it.
      case 'eth_blockNumber': result = '0x10'; break;
      case 'eth_getTransactionReceipt':
        result = {
          blockHash: '0x' + '11'.repeat(32), blockNumber: '0x10', contractAddress: null,
          cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', from: ADDR,
          gasUsed: '0x5208', logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x1',
          to: TO, transactionHash: req.params[0], transactionIndex: '0x0', type: '0x0',
        };
        break;
    }
    return { jsonrpc: '2.0', id: req.id, result };
  };
  const payload = Array.isArray(body) ? body.map(answer) : answer(body);
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
afterAll(async () => {
  // Let the receipt polls started above settle before the real fetch is back.
  await new Promise((r) => setTimeout(r, 50));
  globalThis.fetch = realFetch;
});

function popup(action: string, payload: unknown) {
  return dispatchRuntimeMessage(
    { source: MSG_SOURCE, id: 'p', type: 'popup_request', action, payload },
    extensionSender('popup.html'),
  ).then((res) => {
    if (res.error) throw new Error(res.error);
    return res.result;
  });
}

const LEGACY_FEE = { type: 'legacy', gas: '21000', maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: '1000000000' };

function txLog(): any[] {
  return fake.chrome.storage.local._dump().tx_log as any[];
}

beforeEach(async () => {
  rawTxs.length = 0;
  await keyManager.lock();
  await resetFakeChrome();
  connectedSites.resetSeedingForTests();
  await networkManager.seedPresetsIfNeeded();
  await networkManager.switchNetwork(1);
  await keyManager.importPrivateKey(PK, 'pw-12345678');
});

describe('custom nonce (item 16)', () => {
  test('wallet send uses the nonce the user typed', async () => {
    await popup('sendNative', { to: TO, amount: '0.01', fee: { ...LEGACY_FEE, nonce: '5' } });
    expect(parseTransaction(rawTxs[0]!).nonce).toBe(5);
    expect(txLog()[0].nonce).toBe(5);
  });

  test('wallet send without a typed nonce uses the pending nonce', async () => {
    await popup('sendNative', { to: TO, amount: '0.01', fee: { ...LEGACY_FEE, nonce: null } });
    expect(parseTransaction(rawTxs[0]!).nonce).toBe(PENDING_NONCE);
  });

  test('an invalid typed nonce is refused before anything is signed', async () => {
    await expect(popup('sendNative', { to: TO, amount: '0.01', fee: { ...LEGACY_FEE, nonce: '-3' } })).rejects.toThrow(/nonce/i);
    expect(rawTxs).toEqual([]);
  });

  test('dApp transaction uses the nonce set in the confirm popup', async () => {
    await connectedSites.connectSite(DAPP);
    fake.state.onWindowCreated = async (win) => {
      const id = new URL(win.url).searchParams.get('id')!;
      await dispatchRuntimeMessage(
        { source: MSG_SOURCE, type: 'confirm_response', requestId: id, approved: true, feeOverride: { ...LEGACY_FEE, nonce: '11' } },
        extensionSender(`confirm.html?id=${id}`),
      );
    };
    await handleRpcMethod('eth_sendTransaction', [{ from: ADDR, to: TO, value: '0x1' }], DAPP, pageSender(`${DAPP}/`));
    expect(parseTransaction(rawTxs[0]!).nonce).toBe(11);
    expect(txLog()[0].nonce).toBe(11);
  });

  test('nonce suggestion for the confirm popup reads the given account on the given chain', async () => {
    expect(await popup('getNonceSuggestion', { address: ADDR, chainId: 1 })).toEqual({ latest: PENDING_NONCE, pending: PENDING_NONCE });
  });
});

describe('token send history (item 17)', () => {
  test('logs the token transfer, not a native value', async () => {
    await popup('sendToken', {
      to: TO, amount: '1.5', tokenAddress: TOKEN, decimals: 6, symbol: 'USDC',
      fee: { ...LEGACY_FEE, gas: '60000', nonce: null },
    });
    const tx = parseTransaction(rawTxs[0]!);
    expect(tx.to!.toLowerCase()).toBe(TOKEN);
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(call.args).toEqual([TO, 1_500_000n]);

    const entry = txLog()[0];
    expect(entry.value).toBe('0');
    expect(entry.to.toLowerCase()).toBe(TOKEN);
    expect(entry.tokenTransfer).toEqual({ token: TOKEN, symbol: 'USDC', decimals: 6, amount: '1500000', recipient: TO });
  });
});

describe('receipt tracking', () => {
  test('a send is marked confirmed and notified only once its receipt arrives', async () => {
    const { keepAliveHolds } = await import('../src/background/keepalive');
    await popup('sendNative', { to: TO, amount: '0.01', fee: { ...LEGACY_FEE, nonce: null } });
    // Right after broadcast: pending, no notification yet.
    expect(txLog()[0].status).toBe('pending');
    expect(fake.state.notifications).toEqual([]);

    for (let i = 0; i < 100 && txLog()[0].status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(txLog()[0].status).toBe('confirmed');
    expect(fake.state.notifications.length).toBe(1);
    expect(keepAliveHolds()).toBe(0);
  });
});
