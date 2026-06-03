// Multiply gas limit by 1.2 to absorb estimation variance. Contract calls'
// actual usage can exceed estimates, so we buffer every send to avoid OOG.
export function bufferGas(gas: bigint): bigint {
  return (gas * 12n) / 10n;
}

/**
 * The wallet's gas-limit policy used by every send path:
 *  - If the caller supplied an explicit gas value (dApp tx, FeeEditor's
 *    auto-fill, Ledger-prepared tx), trust it verbatim — re-buffering would
 *    either double-apply the suggestion's buffer or silently inflate a value
 *    the user/dApp typed deliberately.
 *  - Otherwise, estimate fresh and apply the ×1.2 buffer.
 *
 * `getFeeSuggestions` itself returns the buffered estimate so that FeeEditor's
 * auto-filled gas input still ends up at ×1.2 when it flows back through this
 * helper as a "provided" value.
 */
export async function applyGasPolicy(
  providedGas: bigint | null | undefined,
  estimate: () => Promise<bigint>,
): Promise<bigint> {
  if (providedGas !== null && providedGas !== undefined) return providedGas;
  return bufferGas(await estimate());
}

// Some RPCs return a zero (or near-zero) priorityFee estimate, which can cause
// txs to sit unmined on busy chains. Floor every auto-estimate at 10000 wei.
// User-supplied overrides go through unchanged.
export const MIN_PRIORITY_FEE_WEI = 10_000n;

export function floorPriorityFee(priority: bigint | null | undefined): bigint {
  if (priority === null || priority === undefined) return MIN_PRIORITY_FEE_WEI;
  return priority < MIN_PRIORITY_FEE_WEI ? MIN_PRIORITY_FEE_WEI : priority;
}

/** Bump priority to the floor, and raise maxFeePerGas by the same delta so the
 *  baseFee + priority headroom is preserved. */
export function clampEstimatedFees(fees: {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (fees.maxPriorityFeePerGas >= MIN_PRIORITY_FEE_WEI) return fees;
  const delta = MIN_PRIORITY_FEE_WEI - fees.maxPriorityFeePerGas;
  return {
    maxPriorityFeePerGas: MIN_PRIORITY_FEE_WEI,
    maxFeePerGas: fees.maxFeePerGas + delta,
  };
}

// --- Replacement (speed-up / cancel) fee policy ---
//
// To replace a stuck transaction, the wallet broadcasts a new one at the SAME
// nonce with strictly higher fees. Geth-family nodes reject a replacement
// unless every fee field is at least ~10% above the original (the configurable
// `txpool.pricebump`, default 10). We bump by 30% to clear that threshold with
// comfortable margin and to give the replacement real priority in the mempool.
export const REPLACEMENT_BUMP_NUM = 13n;
export const REPLACEMENT_BUMP_DEN = 10n;

/** Bump a fee by +30%, rounding up so even tiny values clear the >10% rule. */
export function bumpFee(original: bigint): bigint {
  return (original * REPLACEMENT_BUMP_NUM + REPLACEMENT_BUMP_DEN - 1n) / REPLACEMENT_BUMP_DEN;
}

export interface ReplacementFees {
  type: 'eip1559' | 'legacy';
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

interface FeeFields {
  maxFeePerGas?: bigint | null;
  maxPriorityFeePerGas?: bigint | null;
  gasPrice?: bigint | null;
}

/**
 * Derive the fees for a replacement transaction from the original tx's fees,
 * optionally raised further by the network's current suggestion.
 *
 * Each field is `max(original × 1.3, networkSuggestion)`:
 *  - The ×1.3 floor guarantees the replacement always beats the original by
 *    >10%, so the node accepts it.
 *  - Taking the network suggestion when it's higher means a replacement still
 *    mines even if the base fee spiked after the original was sent (otherwise a
 *    +30% bump over a now-cheap original could still sit below the current base
 *    fee).
 *
 * The original's type (EIP-1559 vs legacy) is preserved. An EIP-1559
 * replacement's priority is also floored at MIN_PRIORITY_FEE_WEI, and maxFee is
 * never allowed to drop below the priority fee.
 */
export function computeReplacementFees(original: FeeFields, network?: FeeFields): ReplacementFees {
  const raise = (floor: bigint, suggestion: bigint | null | undefined): bigint =>
    suggestion != null && suggestion > floor ? suggestion : floor;

  if (original.maxFeePerGas != null) {
    const priority = floorPriorityFee(
      raise(bumpFee(original.maxPriorityFeePerGas ?? 0n), network?.maxPriorityFeePerGas),
    );
    let maxFeePerGas = raise(bumpFee(original.maxFeePerGas), network?.maxFeePerGas);
    if (maxFeePerGas < priority) maxFeePerGas = priority;
    return { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas: priority };
  }

  const gasPrice = raise(bumpFee(original.gasPrice ?? 0n), network?.gasPrice);
  return { type: 'legacy', gasPrice };
}
