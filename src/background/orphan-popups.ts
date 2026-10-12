// When the service worker starts, any confirm / unlock popup still open was
// created by a previous worker instance. Its pending request died with that
// worker, so clicking Approve would do nothing. Close those windows and drop
// their stored request data.

const ORPHAN_PAGES = ['confirm.html', 'unlock.html'];

export interface LivePopups {
  /** Confirm request ids this worker is waiting on. */
  requestIds: Set<string>;
  /** Popup windows this worker opened (e.g. its unlock window). */
  windowIds: Set<number>;
}

/**
 * `getLive` is read after the open pages are listed, so popups this worker
 * opened in the meantime (a dApp request may be what woke it) are kept.
 */
export async function closeOrphanedPopups(getLive: () => LivePopups): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
  });
  const live = getLive();
  const base = chrome.runtime.getURL('');
  const windowIds = new Set<number>();
  for (const ctx of contexts) {
    if (!ctx.documentUrl?.startsWith(base) || ctx.windowId === -1) continue;
    const url = new URL(ctx.documentUrl);
    const page = url.pathname.replace(/^\//, '');
    if (!ORPHAN_PAGES.includes(page)) continue;
    if (live.windowIds.has(ctx.windowId)) continue;
    const requestId = url.searchParams.get('id');
    if (page === 'confirm.html' && requestId !== null && live.requestIds.has(requestId)) continue;
    windowIds.add(ctx.windowId);
  }
  await Promise.all([...windowIds].map((id) => chrome.windows.remove(id).catch(() => undefined)));

  const session = await chrome.storage.session.get(null);
  const staleKeys = Object.keys(session).filter((k) => {
    const m = /^confirm_(.+?)(_simulation)?$/.exec(k);
    return m !== null && !live.requestIds.has(m[1]!);
  });
  if (staleKeys.length > 0) await chrome.storage.session.remove(staleKeys);
}
