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
