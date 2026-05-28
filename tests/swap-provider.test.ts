import { test, expect, describe, afterEach } from 'bun:test';
import {
  isEvmChainId,
  isNativeAddress,
  NATIVE_TOKEN_ADDRESS,
  pickBestSlot,
  type NeutralQuote,
  type ProviderToken,
  type QuoteSlot,
} from '../src/lib/swap';
import {
  isXFlowsTerminalError,
  toNeutralQuote,
  XFlowsProvider,
} from '../src/lib/swap/xflows-provider';
import type { XfQuote } from '../src/lib/xflows';

describe('swap/types EVM filter', () => {
  test('Ethereum, Base, Wanchain are EVM', () => {
    expect(isEvmChainId(1)).toBe(true);
    expect(isEvmChainId(8453)).toBe(true);
    expect(isEvmChainId(888)).toBe(true);
  });

  test('Tron and Solana are not EVM', () => {
    expect(isEvmChainId(195)).toBe(false);
    expect(isEvmChainId(501)).toBe(false);
  });

  test('XFlows-style sentinel chain ids (Bitcoin/Cardano/Sui/XRPL) are not EVM', () => {
    // XFlows uses ids past 2^31 for non-EVM chains. Anything above 1M is treated
    // as non-EVM.
    expect(isEvmChainId(20000000147)).toBe(false);
    expect(isEvmChainId(2_000_000)).toBe(false);
  });

  test('non-positive and NaN are not EVM', () => {
    expect(isEvmChainId(0)).toBe(false);
    expect(isEvmChainId(-1)).toBe(false);
    expect(isEvmChainId(NaN)).toBe(false);
  });
});

describe('swap/types native token', () => {
  test('zero address (lower & mixed case) is native', () => {
    expect(isNativeAddress(NATIVE_TOKEN_ADDRESS)).toBe(true);
    expect(isNativeAddress('0x0000000000000000000000000000000000000000')).toBe(true);
  });

  test('any non-zero address is not native', () => {
    expect(isNativeAddress('0x1111111111111111111111111111111111111111')).toBe(false);
    expect(isNativeAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(false);
  });
});

describe('XFlows rubic extraData → neutral quote', () => {
  // For rubic-routed quotes XFlows returns empty `nativeFees`/`tokenFees`
  // and instead places the fee breakdown + duration under
  // `extraData.dex.{fees,estimate}`. Verify we surface them in the neutral
  // quote so the user can see what they're paying.

  const usdc: ProviderToken = {
    chainId: 42161, address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    symbol: 'USDC', name: 'USD Coin', decimals: 6, logo: '',
  };
  const usdt: ProviderToken = {
    chainId: 42161, address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    symbol: 'USD₮0', name: 'USD₮0', decimals: 6, logo: '',
  };

  const rubicSample: XfQuote = {
    amountOut: '4.000718',
    amountOutRaw: '4000718',
    slippage: 0.01,
    amountOutMin: '3.960711',
    amountOutMinRaw: '3960711',
    priceImpact: 0.01,
    approvalAddress: '0x3335733c454805df6a77f825f266e136FB4a3333',
    workMode: 5,
    dex: 'rubic',
    nativeFees: [],
    tokenFees: [],
    extraData: {
      dex: {
        estimate: { durationInMinutes: 1, destinationUsdAmount: 4 },
        fees: {
          gasTokenFees: {
            gas: { totalWeiAmount: '9211920000000', totalUsdAmount: 0.03 },
            nativeToken: { symbol: 'ETH', decimals: 18 },
            protocol: { fixedWeiAmount: '977192330994586', fixedUsdAmount: 2.17 },
            provider: { fixedWeiAmount: '0', fixedUsdAmount: 0 },
          },
          percentFees: {
            percent: 0,
            token: { symbol: 'USDC' },
          },
        },
      },
    },
  };

  test('lifts gas + protocol fees out of extraData when top-level arrays are empty', () => {
    const q = toNeutralQuote(rubicSample, {
      fromChainId: 42161, toChainId: 42161,
      fromToken: usdc, toToken: usdt,
      fromAddress: '0x0', toAddress: '0x0',
      fromAmount: '4', slippage: 0.01,
    });
    // Two fees: gas (Network) + protocol; provider=0 and percent=0 dropped.
    expect(q.fees.length).toBe(2);
    expect(q.fees[0]?.label).toBe('Network fee');
    expect(q.fees[0]?.symbol).toBe('ETH');
    expect(q.fees[1]?.label).toBe('Protocol fee');
    expect(q.fees[1]?.symbol).toBe('ETH');
  });

  test('reads ETA from extraData.dex.estimate.durationInMinutes', () => {
    const q = toNeutralQuote(rubicSample, {
      fromChainId: 42161, toChainId: 42161,
      fromToken: usdc, toToken: usdt,
      fromAddress: '0x0', toAddress: '0x0',
      fromAmount: '4', slippage: 0.01,
    });
    expect(q.estimatedTimeSeconds).toBe(60);
  });

  test('does not double-count when top-level fees are present', () => {
    // When the API populates nativeFees/tokenFees we trust those; the rubic
    // fallback only fires when the top-level arrays are empty.
    const populated: XfQuote = {
      ...rubicSample,
      nativeFees: [{ nativeFeeAmount: '1000000000000000', nativeFeeSymbol: 'ETH', nativeFeeDecimals: 18 }],
      tokenFees: [],
    };
    const q = toNeutralQuote(populated, {
      fromChainId: 42161, toChainId: 42161,
      fromToken: usdc, toToken: usdt,
      fromAddress: '0x0', toAddress: '0x0',
      fromAmount: '4', slippage: 0.01,
    });
    expect(q.fees.length).toBe(1);
    expect(q.fees[0]?.label).toBe('Network fee');
  });

  test('computes netValueUsd = destinationUsdAmount − sum(extra gas/protocol/provider USD)', () => {
    const q = toNeutralQuote(rubicSample, {
      fromChainId: 42161, toChainId: 42161,
      fromToken: usdc, toToken: usdt,
      fromAddress: '0x0', toAddress: '0x0',
      fromAmount: '4', slippage: 0.01,
    });
    // 4 − (0.03 + 2.17 + 0) = 1.80
    expect(q.amountOutUsd).toBe(4);
    expect(q.netValueUsd).toBeCloseTo(1.8, 5);
  });

  test('netValueUsd is undefined when extraData has no USD fields', () => {
    const noUsd: XfQuote = {
      ...rubicSample,
      extraData: {
        dex: {
          estimate: { durationInMinutes: 1 },
          fees: {
            gasTokenFees: {
              gas: { totalWeiAmount: '9211920000000' },
              nativeToken: { symbol: 'ETH', decimals: 18 },
              protocol: { fixedWeiAmount: '977192330994586' },
              provider: { fixedWeiAmount: '0' },
            },
            percentFees: { percent: 0, token: { symbol: 'USDC' } },
          },
        },
      },
    };
    const q = toNeutralQuote(noUsd, {
      fromChainId: 42161, toChainId: 42161,
      fromToken: usdc, toToken: usdt,
      fromAddress: '0x0', toAddress: '0x0',
      fromAmount: '4', slippage: 0.01,
    });
    expect(q.netValueUsd).toBeUndefined();
  });

  test('drops the percent fee row when percent is non-zero', () => {
    const withPct: XfQuote = {
      ...rubicSample,
      extraData: {
        dex: {
          estimate: { durationInMinutes: 1 },
          fees: {
            gasTokenFees: {
              gas: { totalWeiAmount: '0' },
              nativeToken: { symbol: 'ETH', decimals: 18 },
              protocol: { fixedWeiAmount: '0' },
              provider: { fixedWeiAmount: '0' },
            },
            percentFees: { percent: 0.003, token: { symbol: 'USDC' } },
          },
        },
      },
    };
    const q = toNeutralQuote(withPct, {
      fromChainId: 42161, toChainId: 42161,
      fromToken: usdc, toToken: usdt,
      fromAddress: '0x0', toAddress: '0x0',
      fromAmount: '4', slippage: 0.01,
    });
    expect(q.fees.length).toBe(1);
    expect(q.fees[0]?.label).toBe('DEX fee');
    expect(q.fees[0]?.amount).toBe('0.30%');
    expect(q.fees[0]?.symbol).toBe('USDC');
  });
});

describe('XFlows status terminal-error classifier', () => {
  test('messages naming an on-chain failure are terminal', () => {
    expect(isXFlowsTerminalError('Tx Failed')).toBe(true);
    expect(isXFlowsTerminalError('tx failed')).toBe(true);
    expect(isXFlowsTerminalError('Transaction Failed: out of gas')).toBe(true);
    expect(isXFlowsTerminalError('execution reverted')).toBe(true);
  });

  test('transient or unrelated errors are not terminal', () => {
    expect(isXFlowsTerminalError('XFlows /status HTTP 500')).toBe(false);
    expect(isXFlowsTerminalError('Tx not found')).toBe(false);
    expect(isXFlowsTerminalError('fetch failed')).toBe(false);
    expect(isXFlowsTerminalError('')).toBe(false);
  });
});

describe('XFlowsProvider.getStatus error handling', () => {
  // Stash & restore global fetch so each test can stage a different response
  // for the /status endpoint without leaking into other tests.
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const wan: ProviderToken = {
    chainId: 888, address: NATIVE_TOKEN_ADDRESS,
    symbol: 'WAN', name: 'Wanchain', decimals: 18, logo: '',
  };
  const ftt: ProviderToken = {
    chainId: 888, address: '0x11e77e27af5539872efed10abaa0b408cfd9fbbd',
    symbol: 'FTT', name: 'FTT', decimals: 18, logo: '',
  };
  const params = {
    fromChainId: 888, toChainId: 888,
    fromToken: wan, toToken: ftt,
    fromAddress: '0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200',
    toAddress: '0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200',
    fromAmount: '20', slippage: 0.01,
  };
  const sourceHash = '0xb8ba57430bd7eed972e0bf2e5ff3cf44513f377343cbf1f82aeca2729232d5eb';

  test('maps {success:false, error:"Tx Failed"} to a failed NeutralStatus instead of throwing', async () => {
    // Repro of the user's bug: XFlows answers HTTP 200 but signals an on-chain
    // revert. The provider must surface this as state:'failed' so the poller
    // stops, rather than re-throwing and letting the UI spin forever.
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ success: false, error: 'Tx Failed' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const provider = new XFlowsProvider();
    const status = await provider.getStatus({ params, sourceHash });
    expect(status.state).toBe('failed');
    expect(status.message).toBe('Tx Failed');
    expect(status.sourceHash).toBe(sourceHash);
    expect(status.receiveSymbol).toBe('FTT');
  });

  test('re-throws transient HTTP errors so the poller keeps retrying', async () => {
    // 503 / network blip should bubble up — pollSwapStatus uses the throw as
    // its retry signal during the indexing-grace window.
    globalThis.fetch = (async () => new Response('Service Unavailable', { status: 503 })) as unknown as typeof fetch;

    const provider = new XFlowsProvider();
    await expect(provider.getStatus({ params, sourceHash })).rejects.toThrow(/HTTP 503/);
  });

  test('re-throws non-terminal business errors (e.g. tx not yet indexed)', async () => {
    // Anything XFlows reports that doesn't unambiguously mean "the source tx
    // failed on-chain" should keep the poller retrying.
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ success: false, error: 'Tx not found' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const provider = new XFlowsProvider();
    await expect(provider.getStatus({ params, sourceHash })).rejects.toThrow(/Tx not found/);
  });
});

describe('pickBestSlot ranking', () => {
  function slot(id: 'xflows' | 'relay', q: Partial<NeutralQuote>): QuoteSlot {
    const quote: NeutralQuote = {
      providerId: id,
      amountOut: '0',
      amountOutRaw: '0',
      amountOutMin: '0',
      amountOutMinRaw: '0',
      fees: [],
      raw: null,
      ...q,
    };
    return {
      providerId: id,
      displayName: id,
      loading: false,
      quote,
      error: null,
      unsupported: false,
    };
  }

  test('prefers higher net USD value even when amountOutRaw is lower', () => {
    // Matches the screenshot case: XFlows shows a slightly higher amountOut
    // but loses ~$2 in gas/protocol fees, so Relay should win.
    const xflows = slot('xflows', { amountOutRaw: '3000500', netValueUsd: 0.80 });
    const relay = slot('relay', { amountOutRaw: '2997200', netValueUsd: 2.996 });
    expect(pickBestSlot([xflows, relay])?.providerId).toBe('relay');
  });

  test('falls back to amountOutRaw when at least one slot has no USD pricing', () => {
    // No netValueUsd on either → bigger raw wins.
    const a = slot('xflows', { amountOutRaw: '3000500' });
    const b = slot('relay', { amountOutRaw: '2997200' });
    expect(pickBestSlot([a, b])?.providerId).toBe('xflows');

    // Mixed availability → also fall back to raw (we don't compare across
    // different metrics — that would be apples-to-oranges).
    const mixedA = slot('xflows', { amountOutRaw: '3000500', netValueUsd: 0.80 });
    const mixedB = slot('relay', { amountOutRaw: '2997200' });
    expect(pickBestSlot([mixedA, mixedB])?.providerId).toBe('xflows');
  });

  test('ignores slots with no quote (loading/error/unsupported)', () => {
    const ok = slot('xflows', { amountOutRaw: '100', netValueUsd: 1 });
    const empty: QuoteSlot = { ...ok, quote: null };
    expect(pickBestSlot([empty, ok])?.providerId).toBe('xflows');
    expect(pickBestSlot([empty])).toBeNull();
    expect(pickBestSlot([])).toBeNull();
  });
});
