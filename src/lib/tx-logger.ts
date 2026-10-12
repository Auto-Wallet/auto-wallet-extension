import { getItem, setItem, STORAGE_KEYS } from './storage';

export interface TxLogEntry {
  id: string;
  timestamp: number;
  chainId: number;
  from: string;
  to: string;
  value: string;       // wei decimal
  hash?: string;       // tx hash after broadcast
  method?: string;     // 4-byte selector
  origin: string;      // dApp origin
  autoSigned: boolean; // true = matched whitelist
  ruleId?: string;     // which whitelist rule matched
  status: 'pending' | 'confirmed' | 'failed';
  nonce?: number;      // tx nonce — needed to build speed-up / cancel replacements
  // Set once a higher-gas replacement was broadcast for this entry. `hash` then
  // points at the replacement; `prevHash` keeps the superseded hash so the user
  // can still cross-reference the original on an explorer.
  replacementKind?: 'speedup' | 'cancel';
  prevHash?: string;

  // ERC-20 transfer sent from the wallet's Send form. `to` is then the token
  // contract and `value` the native value (0); this holds what moved.
  tokenTransfer?: {
    token: string;     // token contract
    symbol: string;
    decimals: number;
    amount: string;    // raw units, decimal string
    recipient: string;
  };

  // Fee values requested at broadcast time (decimal strings)
  gasLimit?: string;             // gas units
  maxFeePerGas?: string;         // wei
  maxPriorityFeePerGas?: string; // wei
  gasPrice?: string;             // wei (legacy)

  // Actual fee data filled in once the receipt is mined
  gasUsed?: string;              // gas units
  effectiveGasPrice?: string;    // wei
  feeWei?: string;               // gasUsed * effectiveGasPrice (wei)
}

const MAX_LOG_SIZE = 200;

export async function getLog(): Promise<TxLogEntry[]> {
  return (await getItem<TxLogEntry[]>(STORAGE_KEYS.TX_LOG)) ?? [];
}

export async function appendLog(entry: TxLogEntry): Promise<void> {
  const log = await getLog();
  log.unshift(entry); // newest first
  if (log.length > MAX_LOG_SIZE) log.length = MAX_LOG_SIZE;
  await setItem(STORAGE_KEYS.TX_LOG, log);
}

export async function updateLogEntry(id: string, patch: Partial<TxLogEntry>): Promise<void> {
  const log = await getLog();
  const idx = log.findIndex((e) => e.id === id);
  if (idx >= 0) {
    const existing = log[idx];
    if (!existing) return;
    log[idx] = { ...existing, ...patch };
    await setItem(STORAGE_KEYS.TX_LOG, log);
  }
}

export async function clearLog(): Promise<void> {
  await setItem(STORAGE_KEYS.TX_LOG, []);
}
