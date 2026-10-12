// Keep the MV3 service worker running while it holds work that only lives in
// memory: a dApp waiting on a confirm popup, or a receipt poll. Chrome stops an
// idle worker after ~30s, and network fetches alone don't count as activity;
// calling an extension API does. Callers take a hold and release it when done.

const PING_INTERVAL_MS = 20_000;

let holds = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function ping(): void {
  chrome.runtime.getPlatformInfo().catch(() => undefined);
}

/** Take a hold; the returned function releases it (safe to call more than once). */
export function acquireKeepAlive(): () => void {
  holds++;
  if (timer === null) timer = setInterval(ping, PING_INTERVAL_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Test-only view of the hold count. */
export function keepAliveHolds(): number {
  return holds;
}
