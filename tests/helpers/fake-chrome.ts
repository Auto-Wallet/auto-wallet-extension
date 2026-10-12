// In-memory stand-in for the parts of the `chrome.*` extension API the
// background code touches. One instance is shared by every test file (bun runs
// all files in one process and modules register listeners at import time), so
// tests call `resetFakeChrome()` instead of installing their own global.

type Listener = (...args: any[]) => any;

export const EXT_ID = 'test-ext-id';
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

function createArea(areaName: 'local' | 'session', changeListeners: Set<Listener>) {
  let data: Record<string, unknown> = {};

  function pick(keys?: string | string[] | null): Record<string, unknown> {
    if (keys === undefined || keys === null) return structuredClone(data);
    const list = typeof keys === 'string' ? [keys] : keys;
    const out: Record<string, unknown> = {};
    for (const k of list) {
      if (k in data) out[k] = structuredClone(data[k]);
    }
    return out;
  }

  function emit(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) {
    if (Object.keys(changes).length === 0) return;
    for (const l of changeListeners) l(changes, areaName);
  }

  return {
    async get(keys?: string | string[] | null, cb?: Listener) {
      const out = pick(keys);
      cb?.(out);
      return out;
    },
    async set(items: Record<string, unknown>, cb?: Listener) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      emit(changes);
      cb?.();
    },
    async remove(keys: string | string[], cb?: Listener) {
      const list = typeof keys === 'string' ? [keys] : keys;
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of list) {
        if (k in data) changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      emit(changes);
      cb?.();
    },
    async clear() {
      data = {};
    },
    /** Test-only: raw view of the stored data. */
    _dump(): Record<string, unknown> {
      return structuredClone(data);
    },
  };
}

export interface FakeTab {
  id: number;
  windowId: number;
  active: boolean;
  url?: string;
}

function createFakeChrome() {
  const changeListeners = new Set<Listener>();
  const messageListeners = new Set<Listener>();
  const windowRemovedListeners = new Set<Listener>();
  const alarmListeners = new Set<Listener>();

  const state = {
    tabs: [] as FakeTab[],
    focusedWindowIds: new Set<number>([1]),
    sentTabMessages: [] as Array<{ tabId: number; message: any }>,
    createdWindows: [] as Array<{ id: number; url: string }>,
    removedWindows: [] as number[],
    notifications: [] as Array<{ id: string; options: any }>,
    alarms: new Map<string, any>(),
    contexts: [] as Array<{ contextType: string; documentUrl: string; windowId: number }>,
    nextWindowId: 100,
    /** Answers chrome.runtime.sendMessage from a content script. */
    onRuntimeSend: null as null | ((message: any) => unknown),
    /** Called after a popup window is created; tests use it to answer the popup. */
    onWindowCreated: null as null | ((win: { id: number; url: string }) => void),
  };

  const chromeObj = {
    storage: {
      local: createArea('local', changeListeners),
      session: createArea('session', changeListeners),
      onChanged: {
        addListener: (l: Listener) => changeListeners.add(l),
        removeListener: (l: Listener) => changeListeners.delete(l),
      },
    },
    runtime: {
      id: EXT_ID,
      lastError: undefined as undefined | { message: string },
      getURL: (path: string) => `${EXT_ORIGIN}/${path.replace(/^\//, '')}`,
      onMessage: {
        addListener: (l: Listener) => messageListeners.add(l),
        removeListener: (l: Listener) => messageListeners.delete(l),
      },
      // Content-script → background calls. Tests set `state.onRuntimeSend` to answer them.
      sendMessage: (message: any, cb?: Listener) => {
        const answer = fake?.state.onRuntimeSend?.(message);
        if (cb) {
          Promise.resolve(answer).then((value) => cb(value));
          return undefined;
        }
        return Promise.resolve(answer);
      },
      getContexts: async (filter: { contextTypes?: string[] }) =>
        state.contexts.filter((c) => !filter.contextTypes || filter.contextTypes.includes(c.contextType)),
      getPlatformInfo: async () => ({ os: 'mac' }),
      onInstalled: { addListener: () => undefined },
      ContextType: { TAB: 'TAB', POPUP: 'POPUP', BACKGROUND: 'BACKGROUND' },
      onStartup: { addListener: () => undefined },
    },
    tabs: {
      query: (_q: unknown, cb?: Listener) => {
        const tabs = structuredClone(state.tabs);
        cb?.(tabs);
        return Promise.resolve(tabs);
      },
      sendMessage: (tabId: number, message: any) => {
        state.sentTabMessages.push({ tabId, message: structuredClone(message) });
        return Promise.resolve(undefined);
      },
    },
    windows: {
      getCurrent: (cb?: Listener) => {
        const win = { id: 1, left: 0, top: 0, width: 1440, height: 900 };
        cb?.(win);
        return Promise.resolve(win);
      },
      get: async (windowId: number) => ({ id: windowId, focused: state.focusedWindowIds.has(windowId) }),
      create: (opts: { url: string }, cb?: Listener) => {
        const win = { id: state.nextWindowId++, url: opts.url };
        state.createdWindows.push(win);
        cb?.(win);
        queueMicrotask(() => state.onWindowCreated?.(win));
        return Promise.resolve(win);
      },
      update: async () => undefined,
      remove: (windowId: number) => {
        state.removedWindows.push(windowId);
        for (const l of [...windowRemovedListeners]) l(windowId);
        return Promise.resolve();
      },
      onRemoved: {
        addListener: (l: Listener) => windowRemovedListeners.add(l),
        removeListener: (l: Listener) => windowRemovedListeners.delete(l),
      },
    },
    notifications: {
      create: (id: string, options: any) => {
        state.notifications.push({ id, options });
      },
      onClicked: { addListener: () => undefined },
      onClosed: { addListener: () => undefined },
      clear: () => undefined,
    },
    alarms: {
      create: (name: string, info: any) => { state.alarms.set(name, info); },
      clear: async (name: string) => state.alarms.delete(name),
      get: async (name: string) => state.alarms.get(name),
      onAlarm: {
        addListener: (l: Listener) => alarmListeners.add(l),
      },
    },
  };

  return { chrome: chromeObj, state, messageListeners, alarmListeners };
}

type FakeChrome = ReturnType<typeof createFakeChrome>;

const g = globalThis as any;
// `var` so createFakeChrome's closures can reach it once assigned.
var fake: FakeChrome = g.__fakeChrome ?? (g.__fakeChrome = createFakeChrome());
export { fake };
g.chrome = fake.chrome;

/** Clear all stored data and recorded calls between tests. */
export async function resetFakeChrome(): Promise<void> {
  await fake.chrome.storage.local.clear();
  await fake.chrome.storage.session.clear();
  fake.state.tabs = [];
  fake.state.focusedWindowIds = new Set([1]);
  fake.state.sentTabMessages = [];
  fake.state.createdWindows = [];
  fake.state.removedWindows = [];
  fake.state.notifications = [];
  fake.state.alarms.clear();
  fake.state.contexts = [];
  fake.state.onWindowCreated = null;
  fake.state.onRuntimeSend = null;
}

/**
 * Deliver a runtime message to every registered onMessage listener, as Chrome
 * would. Resolves with the first value passed to `sendResponse`, or undefined
 * when no listener answers.
 */
export function dispatchRuntimeMessage(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  return new Promise((resolve) => {
    let answered = false;
    let keepOpen = false;
    const sendResponse = (value: any) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    for (const l of [...fake.messageListeners]) {
      if (l(message, sender, sendResponse) === true) keepOpen = true;
    }
    if (!keepOpen) queueMicrotask(() => { if (!answered) resolve(undefined); });
  });
}

/** Sender as seen from one of our own extension pages. */
export function extensionSender(page: string): chrome.runtime.MessageSender {
  return { id: EXT_ID, url: `${EXT_ORIGIN}/${page}`, origin: EXT_ORIGIN };
}

/** Sender as seen from a content script running in a web page tab. */
export function pageSender(url: string, tab: Partial<FakeTab> = {}): chrome.runtime.MessageSender {
  const fullTab = { id: 7, windowId: 1, active: true, ...tab };
  return {
    id: EXT_ID,
    url,
    origin: new URL(url).origin,
    tab: fullTab as unknown as chrome.tabs.Tab,
  };
}
