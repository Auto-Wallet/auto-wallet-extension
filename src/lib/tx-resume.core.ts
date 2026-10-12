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
