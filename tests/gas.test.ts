import { test, expect } from 'bun:test';
import {
  applyGasPolicy,
  bufferGas,
  bumpFee,
  clampEstimatedFees,
  computeReplacementFees,
  floorPriorityFee,
  MIN_PRIORITY_FEE_WEI,
} from '../src/lib/gas';

const GWEI = 1_000_000_000n;

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

// --- Replacement (speed-up / cancel) fee policy ---
//
// A replacement is broadcast at the same nonce; geth-family nodes reject it
// unless every fee field beats the original by >10%. The core invariant these
// tests pin down: computeReplacementFees ALWAYS produces fees that clear that
// threshold (so the node accepts it) while preserving the original's tx type.

test('bumpFee raises by 30%, rounding up', () => {
  expect(bumpFee(100n)).toBe(130n);
  expect(bumpFee(100n * GWEI)).toBe(130n * GWEI);
  expect(bumpFee(0n)).toBe(0n);
  // ceil division keeps tiny values strictly above the +10% rule
  expect(bumpFee(3n)).toBe(4n); // 39/10 -> 4, and 4 > 3*1.1=3.3
});

test('computeReplacementFees bumps EIP-1559 fees +30% with no network input', () => {
  const out = computeReplacementFees({
    maxFeePerGas: 100n * GWEI,
    maxPriorityFeePerGas: 2n * GWEI,
  });
  expect(out.type).toBe('eip1559');
  expect(out.maxFeePerGas).toBe(130n * GWEI);
  expect(out.maxPriorityFeePerGas).toBe((26n * GWEI) / 10n); // 2.6 gwei
  expect(out.gasPrice).toBeUndefined();
});

test('computeReplacementFees takes the network suggestion when it is higher', () => {
  const out = computeReplacementFees(
    { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
    { maxFeePerGas: 200n * GWEI, maxPriorityFeePerGas: 5n * GWEI },
  );
  expect(out.maxFeePerGas).toBe(200n * GWEI);
  expect(out.maxPriorityFeePerGas).toBe(5n * GWEI);
});

test('computeReplacementFees keeps the +30% bump when the network is lower', () => {
  const out = computeReplacementFees(
    { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
    { maxFeePerGas: 110n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
  );
  expect(out.maxFeePerGas).toBe(130n * GWEI); // 110 < 130, bump wins
  expect(out.maxPriorityFeePerGas).toBe((26n * GWEI) / 10n);
});

test('computeReplacementFees floors priority and keeps maxFee >= priority for tiny fees', () => {
  // Pathological dust fees: bumped values fall below the priority floor.
  const out = computeReplacementFees({ maxFeePerGas: 5n, maxPriorityFeePerGas: 1n });
  expect(out.maxPriorityFeePerGas).toBe(MIN_PRIORITY_FEE_WEI);
  // maxFee bumped to 7 would sit below the floored priority — must be lifted.
  expect(out.maxFeePerGas).toBe(MIN_PRIORITY_FEE_WEI);
});

test('computeReplacementFees handles legacy gasPrice transactions', () => {
  const out = computeReplacementFees({ gasPrice: 50n * GWEI });
  expect(out.type).toBe('legacy');
  expect(out.gasPrice).toBe(65n * GWEI); // +30%
  expect(out.maxFeePerGas).toBeUndefined();

  const withNetwork = computeReplacementFees({ gasPrice: 50n * GWEI }, { gasPrice: 80n * GWEI });
  expect(withNetwork.gasPrice).toBe(80n * GWEI);
});

test('computeReplacementFees output always beats the original by >10% (replacement rule)', () => {
  const cases = [
    { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
    { maxFeePerGas: 37n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
    { maxFeePerGas: 999n * GWEI, maxPriorityFeePerGas: 123n * GWEI },
  ];
  for (const orig of cases) {
    const out = computeReplacementFees(orig);
    // strictly greater than original × 1.1 for both fields
    expect(out.maxFeePerGas! * 10n).toBeGreaterThan(orig.maxFeePerGas * 11n);
    expect(out.maxPriorityFeePerGas! * 10n).toBeGreaterThan(orig.maxPriorityFeePerGas * 11n);
    // maxFee must always cover priority
    expect(out.maxFeePerGas! >= out.maxPriorityFeePerGas!).toBe(true);
  }
});
