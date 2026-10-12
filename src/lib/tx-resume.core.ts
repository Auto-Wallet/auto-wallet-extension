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
  cancelHashes?: string[];
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

/** Hashes of this row's cancel txs. Old rows lack the list; their latest hash is the cancel. */
function cancelHashesOf(e: ReplaceableEntry): string[] {
  if (e.cancelHashes) return e.cancelHashes;
  return e.replacementKind === 'cancel' && e.hash ? [e.hash] : [];
}

/**
 * The cancelHashes list to store after broadcasting `newHash`. Speeding up a
 * cancel re-sends the cancel (a 0-value self-transfer), so it is a cancel too.
 */
export function cancelHashesAfterReplace(e: ReplaceableEntry, kind: ReplacementKind, newHash: string): string[] {
  const isCancelTx = kind === 'cancel' || e.replacementKind === 'cancel';
  const known = cancelHashesOf(e);
  return isCancelTx ? [...new Set([...known, newHash])] : known;
}

/**
 * The row's replacement kind once `minedHash` is known. Only one same-nonce tx
 * mines: if it is a cancel tx the row is a cancel; if the original (or a
 * sped-up copy of it) won the race, the transfer went through and the row
 * must not say "cancelled".
 */
export function kindAfterMined(e: ReplaceableEntry, minedHash: string): ReplacementKind | undefined {
  if (cancelHashesOf(e).includes(minedHash)) return 'cancel';
  const original = e.replacedHashes?.[0] ?? e.prevHash ?? e.hash;
  return minedHash === original ? undefined : 'speedup';
}
