import { test, expect } from 'bun:test';
import {
  applyGasPolicy,
  bufferGas,
  clampEstimatedFees,
  floorPriorityFee,
  MIN_PRIORITY_FEE_WEI,
} from '../src/lib/gas';

test('bufferGas multiplies by 1.2', () => {
  expect(bufferGas(100_000n)).toBe(120_000n);
  expect(bufferGas(0n)).toBe(0n);
});

test('floorPriorityFee bumps below-floor estimates to 10000 wei', () => {
  expect(MIN_PRIORITY_FEE_WEI).toBe(10_000n);
  expect(floorPriorityFee(0n)).toBe(10_000n);
  expect(floorPriorityFee(1n)).toBe(10_000n);
  expect(floorPriorityFee(9_999n)).toBe(10_000n);
  expect(floorPriorityFee(null)).toBe(10_000n);
  expect(floorPriorityFee(undefined)).toBe(10_000n);
});

test('floorPriorityFee leaves above-floor estimates untouched', () => {
  expect(floorPriorityFee(10_000n)).toBe(10_000n);
  expect(floorPriorityFee(50_000n)).toBe(50_000n);
  expect(floorPriorityFee(1_000_000_000n)).toBe(1_000_000_000n);
});

test('clampEstimatedFees bumps maxFeePerGas by the same delta as priority', () => {
  // priority=0 -> bumped by 10000; maxFee bumps by the same delta
  const out = clampEstimatedFees({
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 0n,
  });
  expect(out.maxPriorityFeePerGas).toBe(10_000n);
  expect(out.maxFeePerGas).toBe(30_000_010_000n);
});

test('clampEstimatedFees is a no-op when priority is already at or above floor', () => {
  const fees = { maxFeePerGas: 50n, maxPriorityFeePerGas: 12_000n };
  expect(clampEstimatedFees(fees)).toEqual(fees);
});

// --- applyGasPolicy: the core invariant the swap-page bug violated ---
//
// Pre-fix, both resolveGas (popup-handler) and resolveTxGas (rpc-handler)
// re-buffered values they were *already given* (by FeeEditor's auto-fill, by
// a Ledger-prepared tx, or by a dApp). FeeEditor sourced its auto-fill from
// `getFeeSuggestions.gasEstimate`, which returned the raw estimate. So either
// (a) the suggestion's raw value silently overrode the buffered finalGas and
// the tx went out at 1x, or (b) the dApp's gas was secretly inflated 20%.
// applyGasPolicy locks in the new contract: estimate-then-buffer only when
// the caller has nothing to provide.

test('applyGasPolicy returns provided gas verbatim (no re-buffer)', async () => {
  let estimateCalls = 0;
  const result = await applyGasPolicy(120_000n, async () => {
    estimateCalls++;
    return 100_000n;
  });
  expect(result).toBe(120_000n);
  expect(estimateCalls).toBe(0); // shouldn't even touch estimate
});

test('applyGasPolicy estimates and buffers when no gas is provided', async () => {
  for (const empty of [null, undefined]) {
    const result = await applyGasPolicy(empty, async () => 100_000n);
    expect(result).toBe(120_000n); // ×1.2 buffer
  }
});

test('applyGasPolicy respects zero as a deliberate value', async () => {
  // 0n is a valid "provided" value — passing it shouldn't trigger an estimate.
  // (Important: a literal `if (providedGas)` would treat 0n as missing.)
  let estimateCalls = 0;
  const result = await applyGasPolicy(0n, async () => {
    estimateCalls++;
    return 100_000n;
  });
  expect(result).toBe(0n);
  expect(estimateCalls).toBe(0);
});
