export type TokenBalanceDisplay =
  | { kind: 'plain'; text: string }
  | { kind: 'small'; zeroCount: number; digits: string };

function validateBalance(balance: string): void {
  if (!/^\d+(?:\.\d+)?$/.test(balance)) throw new Error(`Invalid token balance: ${balance}`);
}

export function isZeroTokenBalance(balance: string): boolean {
  if (balance === '?') return false;
  validateBalance(balance);
  return !/[1-9]/.test(balance);
}

export function formatTokenBalance(balance: string): TokenBalanceDisplay {
  if (balance === '?') return { kind: 'plain', text: '?' };
  validateBalance(balance);
  const small = /^0+\.(0{4,})([1-9]\d*)$/.exec(balance);
  if (small) {
    return { kind: 'small', zeroCount: small[1]!.length, digits: small[2]!.slice(0, 4).replace(/0+$/, '') };
  }
  const dot = balance.indexOf('.');
  const integer = dot === -1 ? balance : balance.slice(0, dot);
  const fraction = dot === -1 ? '' : balance.slice(dot + 1);
  let scaled = BigInt(integer) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  if (fraction.length > 4 && fraction.charAt(4) >= '5') scaled += 1n;
  return { kind: 'plain', text: `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, '0')}` };
}
