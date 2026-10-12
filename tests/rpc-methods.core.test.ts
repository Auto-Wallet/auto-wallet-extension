import { test, expect, describe } from 'bun:test';
import {
  parseTypedDataRequest,
  assertTypedDataChain,
  parseWatchAssetParams,
  isForegroundTab,
} from '../src/lib/rpc-methods.core';

const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const TYPED = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
    Mail: [{ name: 'contents', type: 'string' }],
  },
  primaryType: 'Mail',
  domain: { name: 'Test', chainId: 1 },
  message: { contents: 'hi' },
};

describe('parseTypedDataRequest', () => {
  test('v4 with JSON string payload', () => {
    const r = parseTypedDataRequest('eth_signTypedData_v4', [ADDR, JSON.stringify(TYPED)]);
    expect(r.address).toBe(ADDR);
    expect(r.typedData).toEqual(TYPED);
  });

  test('v4 / v3 / bare name with object payload', () => {
    for (const m of ['eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_signTypedData']) {
      expect(parseTypedDataRequest(m, [ADDR, TYPED]).typedData.primaryType).toBe('Mail');
    }
  });

  test('legacy v1 array payload is rejected as unsupported (4200)', () => {
    const v1 = [[{ type: 'string', name: 'Message', value: 'Hi' }], ADDR];
    try {
      parseTypedDataRequest('eth_signTypedData', v1);
      throw new Error('should throw');
    } catch (e: any) {
      expect(e.code).toBe(4200);
    }
  });

  test('malformed payloads are rejected as invalid params (-32602)', () => {
    const bad: unknown[][] = [
      [ADDR],
      [ADDR, 'not json'],
      [ADDR, { ...TYPED, primaryType: undefined }],
      [ADDR, { ...TYPED, types: undefined }],
      [ADDR, { ...TYPED, primaryType: 'Missing' }],
      [ADDR, { ...TYPED, message: undefined }],
      ['not-an-address', TYPED],
    ];
    for (const params of bad) {
      try {
        parseTypedDataRequest('eth_signTypedData_v4', params);
        throw new Error(`should throw for ${JSON.stringify(params).slice(0, 60)}`);
      } catch (e: any) {
        expect(e.code).toBe(-32602);
      }
    }
  });
});

describe('assertTypedDataChain', () => {
  test('matching chain id in any common encoding passes', () => {
    for (const chainId of [137, '137', '0x89', 137n]) {
      expect(() => assertTypedDataChain({ ...TYPED, domain: { chainId } }, 137)).not.toThrow();
    }
  });

  test('domain without chainId passes (e.g. off-chain login messages)', () => {
    expect(() => assertTypedDataChain({ ...TYPED, domain: { name: 'x' } }, 1)).not.toThrow();
  });

  test('different chain id is rejected', () => {
    expect(() => assertTypedDataChain({ ...TYPED, domain: { chainId: 1 } }, 137)).toThrow(/must match the active chain/);
    expect(() => assertTypedDataChain({ ...TYPED, domain: { chainId: '0x1' } }, 137)).toThrow(/must match/);
  });

  test('unreadable chain id is rejected rather than ignored', () => {
    for (const chainId of ['abc', -1, 1.5, {}, '']) {
      expect(() => assertTypedDataChain({ ...TYPED, domain: { chainId } }, 1)).toThrow();
    }
  });
});

describe('parseWatchAssetParams', () => {
  test('EIP-747 object form', () => {
    expect(parseWatchAssetParams({ type: 'ERC20', options: { address: ADDR.toLowerCase(), symbol: 'USDC', decimals: 6 } }))
      .toEqual({ address: ADDR, symbol: 'USDC', decimals: 6 });
  });

  test('array-wrapped form used by some dApps', () => {
    expect(parseWatchAssetParams([{ type: 'ERC20', options: { address: ADDR } }]))
      .toEqual({ address: ADDR, symbol: undefined, decimals: undefined });
  });

  test('rejects non-ERC20 and bad addresses', () => {
    expect(() => parseWatchAssetParams({ type: 'ERC721', options: { address: ADDR } })).toThrow(/ERC20/);
    expect(() => parseWatchAssetParams({ type: 'ERC20', options: { address: '0x123' } })).toThrow(/address/);
    expect(() => parseWatchAssetParams({ type: 'ERC20' })).toThrow();
    expect(() => parseWatchAssetParams(undefined)).toThrow();
  });

  test('rejects nonsense decimals', () => {
    expect(() => parseWatchAssetParams({ type: 'ERC20', options: { address: ADDR, decimals: 99 } })).toThrow(/decimals/);
  });
});

describe('isForegroundTab', () => {
  test('only the active tab of its window counts', () => {
    expect(isForegroundTab({ tab: { active: true } as chrome.tabs.Tab })).toBe(true);
    expect(isForegroundTab({ tab: { active: false } as chrome.tabs.Tab })).toBe(false);
    expect(isForegroundTab({})).toBe(false);
  });
});
