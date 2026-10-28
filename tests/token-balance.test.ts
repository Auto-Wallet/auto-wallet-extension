import { expect, test } from 'bun:test';
import { formatTokenBalance, isZeroTokenBalance } from '../src/lib/token-balance';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenBalance } from '../src/popup/TokenBalance';

test('a tiny nonzero balance shows its leading-zero count and significant digits', () => {
  expect(formatTokenBalance('0.000000123456789')).toEqual({ kind: 'small', zeroCount: 6, digits: '1234' });
});

test('large balances retain their exact integer digits and round only the displayed fraction', () => {
  expect(formatTokenBalance('123456789012345678901234.12345678')).toEqual({
    kind: 'plain', text: '123456789012345678901234.1235',
  });
});

test('only exact zero balances are hidden; tiny balances and read errors remain visible', () => {
  const balances = ['0', '0.000000', '000.000', '0.000000000000000001', '0.0024', '123.45', '?'];
  expect(balances.filter((balance) => !isZeroTokenBalance(balance))).toEqual([
    '0.000000000000000001', '0.0024', '123.45', '?',
  ]);
});

test.each([
  ['0', '0.0000'], ['12', '12.0000'], ['0.0024', '0.0024'], ['0.0001', '0.0001'],
  ['0.002456789', '0.0025'], ['0.99999', '1.0000'], ['999.99996', '1000.0000'], ['?', '?'],
])('formats an ordinary balance %s as %s', (balance, text) => {
  expect(formatTokenBalance(balance)).toEqual({ kind: 'plain', text });
});

test.each([4, 5, 8, 17, 64, 253])('counts %i leading zeros exactly without using floating point', (zeroCount) => {
  const balance = `0.${'0'.repeat(zeroCount)}19`;
  expect(isZeroTokenBalance(balance)).toBe(false);
  expect(formatTokenBalance(balance)).toEqual({ kind: 'small', zeroCount, digits: '19' });
});

test('removes trailing display zeros but keeps zeros within significant digits', () => {
  expect(formatTokenBalance('0.0000010000')).toEqual({ kind: 'small', zeroCount: 5, digits: '1' });
  expect(formatTokenBalance('0.0000010203')).toEqual({ kind: 'small', zeroCount: 5, digits: '102' });
});

test.each(['', 'NaN', 'Infinity', '-1', '1e-18', '0x0', 'invalid'])('rejects invalid balance %s instead of hiding it', (balance) => {
  expect(() => isZeroTokenBalance(balance)).toThrow('Invalid token balance');
  expect(() => formatTokenBalance(balance)).toThrow('Invalid token balance');
});

test('renders a real subscript and keeps the full balance available to assistive tools and hover', () => {
  const balance = '0.000000123456789';
  const html = renderToStaticMarkup(createElement(TokenBalance, { balance }));
  expect(html).toContain('0.0<sub>6</sub>1234');
  expect(html).toContain(`title="${balance}"`);
  expect(html).toContain(`aria-label="${balance}"`);
  expect(html).not.toContain('0.0000</span>');
});
