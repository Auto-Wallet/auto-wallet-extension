import { describe, expect, test } from 'bun:test';
import { parseNextNonceFromError, retryWithNextNonce, parseNonceInput, sendWithNonce } from '../src/lib/nonce';

describe('nonce retry helpers', () => {
  test('parses next nonce from viem nonce-too-low errors', () => {
    const error = new Error(
      'Nonce provided for the transaction (142) is lower than the current nonce of the account. ' +
      'Details: nonce too low: next nonce 144, tx nonce 142',
    );

    expect(parseNextNonceFromError(error)).toBe(144);
  });

  test('retries once with the next nonce', async () => {
    const seen: Array<number | null> = [];
    const result = await retryWithNextNonce(async (nonce) => {
      seen.push(nonce);
      if (nonce === null) throw new Error('nonce too low: next nonce 144, tx nonce 142');
      return `sent:${nonce}`;
    });

    expect(result).toBe('sent:144');
    expect(seen).toEqual([null, 144]);
  });

});

describe('parseNonceInput', () => {
  test('blank means "pick automatically"', () => {
    expect(parseNonceInput('')).toBeNull();
    expect(parseNonceInput('   ')).toBeNull();
    expect(parseNonceInput(null)).toBeNull();
  });

  test('accepts non-negative whole numbers', () => {
    expect(parseNonceInput('0')).toBe(0);
    expect(parseNonceInput(' 42 ')).toBe(42);
    expect(parseNonceInput('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('rejects anything else', () => {
    for (const v of ['-1', '1.5', '0x10', 'abc', '1e3', '9007199254740992']) {
      expect(() => parseNonceInput(v)).toThrow(/nonce/i);
    }
  });
});

describe('sendWithNonce', () => {
  test('a user-chosen nonce is sent once and never silently replaced', async () => {
    const seen: Array<number | null> = [];
    await expect(sendWithNonce(7, async (nonce) => {
      seen.push(nonce);
      throw new Error('nonce too low: next nonce 9, tx nonce 7');
    })).rejects.toThrow(/next nonce 9/);
    expect(seen).toEqual([7]);
  });

  test('without a chosen nonce it keeps the auto-retry behaviour', async () => {
    const seen: Array<number | null> = [];
    const out = await sendWithNonce(null, async (nonce) => {
      seen.push(nonce);
      if (nonce === null) throw new Error('nonce too low: next nonce 3, tx nonce 2');
      return nonce;
    });
    expect(out).toBe(3);
    expect(seen).toEqual([null, 3]);
  });
});
