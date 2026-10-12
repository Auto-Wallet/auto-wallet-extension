// Pure selection of tx-history rows whose receipt polling should be resumed
// after the service worker restarted. Zero IO.

/** Pending rows older than this are left alone — they were most likely dropped. */
export const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface ResumableEntry {
  id: string;
  status: 'pending' | 'confirmed' | 'failed';
  hash?: string;
  timestamp: number;
}

export function selectResumableTxs<T extends ResumableEntry>(log: T[], now: number, polling: Set<string>): T[] {
  return log.filter((e) =>
    e.status === 'pending'
    && !!e.hash
    && !polling.has(e.id)
    && now - e.timestamp < RESUME_MAX_AGE_MS,
  );
}

type ReplacementKind = 'speedup' | 'cancel';

interface ReplaceableEntry {
  hash?: string;
  prevHash?: string;
  replacedHashes?: string[];
  replacementKind?: ReplacementKind;
}

/**
 * Every hash that could hold this row's receipt. After a speed-up or cancel,
 * any of the same-nonce txs may be the one that mined — including the
 * original, if it landed before the replacement.
 */
export function receiptCandidates(e: ReplaceableEntry): string[] {
  if (!e.hash) return [];
  // Rows written before replacedHashes existed only kept the last one in prevHash.
  const older = e.replacedHashes ?? (e.prevHash ? [e.prevHash] : []);
  return [...new Set([e.hash, ...older])];
}

/** The replacedHashes list to store when the row's current hash is being replaced. */
export function supersededHashes(e: ReplaceableEntry): string[] {
  if (!e.hash) throw new Error('Cannot replace a transaction that has no hash');
  const older = e.replacedHashes ?? (e.prevHash ? [e.prevHash] : []);
  return [...new Set([...older, e.hash])];
}

/** The fields of a mined tx that tell a cancel from the original transfer. */
export interface MinedTx {
  from: string;
  to: string | null;
  value: bigint;
  input: string;
}

/** A cancel is a 0-value send with no data to the sender's own address (see replacePendingTx). */
export function isCancelTx(tx: MinedTx): boolean {
  return tx.to !== null
    && tx.to.toLowerCase() === tx.from.toLowerCase()
    && tx.value === 0n
    && (tx.input === '0x' || tx.input === '');
}

/**
 * Rows that were ever cancelled need the mined tx's contents: any of their
 * same-nonce txs may be the original, a sped-up copy or a cancel, and old
 * rows don't record which hash is which. One rule for old and new rows.
 */
export function needsMinedTx(e: ReplaceableEntry): boolean {
  return e.replacementKind === 'cancel';
}

/**
 * The row's replacement kind once `minedHash` is known. Only one same-nonce tx
 * mines: if it is a cancel the row is a cancel; if the original (or a sped-up
 * copy of it) won the race, the transfer went through and the row must not
 * say "cancelled".
 */
export function kindAfterMined(e: ReplaceableEntry, minedHash: string, minedTx?: MinedTx): ReplacementKind | undefined {
  if (needsMinedTx(e)) {
    if (!minedTx) throw new Error('kindAfterMined: a cancelled row needs the mined tx');
    if (isCancelTx(minedTx)) return 'cancel';
  }
  // Not a cancel. Old rows may have lost older hashes, so "original" is the
  // oldest one we know; at worst a sped-up copy is shown without its badge.
  const original = e.replacedHashes?.[0] ?? e.prevHash ?? e.hash;
  return minedHash === original ? undefined : 'speedup';
}
