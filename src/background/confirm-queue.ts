/** Result used when the wallet locks (or the popup is otherwise cancelled). */
export interface RejectedConfirmation {
  approved: false;
}

interface PendingConfirmation<T extends { approved: boolean }> {
  id: string;
  windowId: number | null;
  resolve: (result: T) => void;
}

/**
 * In-memory queue of in-flight confirmation popups.
 *
 * Lock must drain this queue: every pending request is rejected, and any
 * attached popup window ids are returned so the caller can close them.
 */
export function createConfirmQueue<T extends { approved: boolean } = { approved: boolean }>() {
  const pending = new Map<string, PendingConfirmation<T>>();

  return {
    add(id: string, resolve: (result: T) => void): void {
      pending.set(id, { id, windowId: null, resolve });
    },

    has(id: string): boolean {
      return pending.has(id);
    },

    setWindowId(id: string, windowId: number): boolean {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.windowId = windowId;
      return true;
    },

    take(id: string): PendingConfirmation<T> | undefined {
      const entry = pending.get(id);
      if (!entry) return undefined;
      pending.delete(id);
      return entry;
    },

    /** Ids and popup windows of requests still waiting for an answer. */
    snapshot(): { ids: Set<string>; windowIds: Set<number> } {
      const ids = new Set<string>();
      const windowIds = new Set<number>();
      for (const entry of pending.values()) {
        ids.add(entry.id);
        if (entry.windowId !== null) windowIds.add(entry.windowId);
      }
      return { ids, windowIds };
    },

    rejectAll(): { ids: string[]; windowIds: number[] } {
      const ids: string[] = [];
      const windowIds: number[] = [];
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) {
        ids.push(entry.id);
        if (entry.windowId !== null) windowIds.push(entry.windowId);
        entry.resolve({ approved: false } as T);
      }
      return { ids, windowIds };
    },
  };
}
