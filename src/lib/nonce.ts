export function parseNextNonceFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = message.match(/next nonce\s+(\d+)/i);
  if (!match?.[1]) return null;
  const nonce = Number(match[1]);
  return Number.isSafeInteger(nonce) && nonce >= 0 ? nonce : null;
}

export async function retryWithNextNonce<T>(
  fn: (nonceOverride: number | null) => Promise<T>,
): Promise<T> {
  let nonceOverride: number | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn(nonceOverride);
    } catch (error) {
      const nextNonce = parseNextNonceFromError(error);
      if (nextNonce !== null && nextNonce !== nonceOverride) {
        nonceOverride = nextNonce;
        continue;
      }

      throw error;
    }
  }

  return fn(nonceOverride);
}

/**
 * Parse the nonce field of the fee editor. Blank → null (pick automatically);
 * otherwise a non-negative safe integer, or an error the UI can show.
 */
export function parseNonceInput(input: string | null | undefined): number | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error(`Invalid nonce "${s}": use a whole number`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error(`Invalid nonce "${s}": too large`);
  return n;
}

/**
 * Send with a fixed nonce when the user (or dApp) chose one — exactly once, so
 * a "nonce too low" error reaches the user instead of the tx quietly going out
 * under another nonce. Without one, keep the automatic next-nonce retry.
 */
export async function sendWithNonce<T>(
  fixedNonce: number | null,
  fn: (nonce: number | null) => Promise<T>,
): Promise<T> {
  if (fixedNonce !== null) return fn(fixedNonce);
  return retryWithNextNonce(fn);
}
