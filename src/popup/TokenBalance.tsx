import { formatTokenBalance } from '../lib/token-balance';

export function TokenBalance({ balance }: { balance: string }) {
  const display = formatTokenBalance(balance);
  return (
    <span className="token-card-balance mono" title={balance} aria-label={balance}>
      {display.kind === 'plain' ? display.text : (
        <span aria-hidden="true">0.0<sub>{display.zeroCount}</sub>{display.digits}</span>
      )}
    </span>
  );
}
