import { test, expect, describe } from 'bun:test';
import { approvalSteps } from '../src/lib/swap/approval';

describe('approvalSteps', () => {
  test('enough allowance → nothing to send', () => {
    expect(approvalSteps(1000n, 1000n)).toEqual([]);
    expect(approvalSteps(5000n, 1000n)).toEqual([]);
  });

  test('zero allowance → one approve for exactly the amount (never unlimited)', () => {
    expect(approvalSteps(0n, 1234n)).toEqual([1234n]);
  });

  test('some allowance but not enough → reset to 0 first (USDT rule), then the amount', () => {
    expect(approvalSteps(1n, 1234n)).toEqual([0n, 1234n]);
    expect(approvalSteps(999n, 1000n)).toEqual([0n, 1000n]);
  });

  test('unknown allowance is an error, not a guess', () => {
    expect(() => approvalSteps(null, 10n)).toThrow(/allowance/i);
  });

  test('zero amount is an error', () => {
    expect(() => approvalSteps(0n, 0n)).toThrow(/amount/i);
  });
});
