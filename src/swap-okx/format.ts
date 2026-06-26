import { formatUnits } from 'viem';

export function trimAmount(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}

export function compactAmount(value: string, maxDecimals = 6): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) {
    return n.toLocaleString('en-US', { maximumFractionDigits: Math.min(maxDecimals, 4) });
  }
  if (maxDecimals <= 0 && n > 0) return '< 1';
  const formatted = n.toFixed(maxDecimals).replace(/\.?0+$/, '');
  if (formatted === '0' && n > 0) {
    return `< 0.${'0'.repeat(maxDecimals - 1)}1`;
  }
  return formatted;
}

export function minReceived(amountOut: string, decimals: number, slippagePct: number | null): string {
  if (slippagePct === null) return '';
  if (!/^\d+$/.test(amountOut)) return '';
  const raw = BigInt(amountOut);
  const slippageScale = Math.max(0, Math.round((100 - slippagePct) * 10_000));
  const min = raw * BigInt(slippageScale) / 1_000_000n;
  return trimAmount(formatUnits(min, decimals));
}
