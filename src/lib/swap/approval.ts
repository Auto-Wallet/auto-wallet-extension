// Plan the ERC-20 approve transactions a swap needs. Pure.

/**
 * Returns the approve amounts to send, in order:
 *  - [] when the current allowance already covers `needed`
 *  - [needed] from a zero allowance
 *  - [0, needed] from a non-zero but short allowance: USDT-style tokens revert
 *    when an allowance moves from one non-zero value to another.
 * Always approves exactly `needed` — never an unlimited allowance.
 */
export function approvalSteps(allowance: bigint | null, needed: bigint): bigint[] {
  if (allowance === null) throw new Error('Token allowance is not loaded yet');
  if (needed <= 0n) throw new Error('Approve amount must be greater than zero');
  if (allowance >= needed) return [];
  if (allowance > 0n) return [0n, needed];
  return [needed];
}
