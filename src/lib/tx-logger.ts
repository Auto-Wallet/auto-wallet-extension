import { getItem, setItem, updateItem, STORAGE_KEYS } from './storage';

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
  // Every superseded hash, oldest first. Any of them may be the one that
  // mines, so the restart check looks them all up.
  replacedHashes?: string[];

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

function updateLog(change: (log: TxLogEntry[]) => TxLogEntry[]): Promise<TxLogEntry[]> {
  return updateItem<TxLogEntry[]>(STORAGE_KEYS.TX_LOG, (log) => change(log ?? []));
}

export async function appendLog(entry: TxLogEntry): Promise<void> {
  await updateLog((log) => [entry, ...log].slice(0, MAX_LOG_SIZE)); // newest first
}

export async function updateLogEntry(id: string, patch: Partial<TxLogEntry>): Promise<void> {
  // An entry trimmed off the end of the log is simply gone; nothing to update.
  await updateLog((log) => log.map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

export async function clearLog(): Promise<void> {
  await updateLog(() => []);
}
