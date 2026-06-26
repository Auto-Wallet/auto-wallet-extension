import { expect, test } from 'bun:test';
import { compactAmount, minReceived } from '../src/swap-okx/format';

test('minReceived rounds slippage basis points without floating point floor drift', () => {
  expect(minReceived('1000000', 6, 49.44)).toBe('0.5056');
});

test('compactAmount shows a less-than threshold for tiny non-zero positive amounts', () => {
  expect(compactAmount('0.000000001', 8)).toBe('< 0.00000001');
});
