// Injected into MAIN world — provides window.ethereum (EIP-1193) + EIP-6963

import { MSG_SOURCE, genId } from '../types/messages';
import { isProviderInjectionAllowed } from '../lib/injection-policy';

type EventHandler = (...args: any[]) => void;

class AutoWalletProvider {
  isAutoWallet = true;
  // Flipped to `true` at injection time when no other wallet has claimed
  // window.ethereum, so legacy "Connect Wallet" buttons that only look for
  // MetaMask still work. We never claim it when another provider is present.
  isMetaMask = false;

  private _events: Map<string, Set<EventHandler>> = new Map();
  private _chainId: string = '0x1';
  private _accounts: string[] = [];

  constructor() {
    // Listen for responses and events from content script bridge
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.source !== MSG_SOURCE) return;

      if (event.data.type === 'event') {
        this._handleEvent(event.data.eventName, event.data.payload);
      }
    });

    // Proactively fetch accounts on init so dApps see connected state after reload
    this._init();
  }

  private async _init() {
    try {
      const accounts = await this.request({ method: 'eth_accounts' }) as string[];
      if (accounts.length > 0) {
        this._accounts = accounts;
      }
      const chainId = await this.request({ method: 'eth_chainId' }) as string;
      if (chainId) {
        this._chainId = chainId;
      }
    } catch {}
  }

  // EIP-1193: request
  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const { method, params = [] } = args;

    // No local caching — always forward to background for accurate state
    // (eth_chainId was previously cached locally, causing stale chain after SW restart or popup switch)

    return new Promise((resolve, reject) => {
      const id = genId();

      const handler = (event: MessageEvent) => {
        if (event.source !== window) return;
        if (event.data?.source !== MSG_SOURCE) return;
        if (event.data?.type !== 'rpc_response') return;
        if (event.data?.requestId !== id) return;
        window.removeEventListener('message', handler);

        if (event.data.error) {
          const err = new Error(event.data.error.message);
          (err as any).code = event.data.error.code;
          reject(err);
        } else {
          // Update local cache
          if (method === 'eth_requestAccounts') {
            this._accounts = event.data.result as string[];
          } else if (method === 'eth_chainId') {
            this._chainId = event.data.result as string;
          } else if (method === 'wallet_switchEthereumChain') {
            const p = params[0] as { chainId: string };
            this._chainId = p.chainId;
            this._emit('chainChanged', p.chainId);
          }
          resolve(event.data.result);
        }
      };

      window.addEventListener('message', handler);

      window.postMessage(
        {
          source: MSG_SOURCE,
          id,
          type: 'rpc_request',
          method,
          params,
          origin: window.location.origin,
        },
        '*',
      );
    });
  }

  // Legacy: enable() = eth_requestAccounts
  async enable(): Promise<string[]> {
    return this.request({ method: 'eth_requestAccounts' }) as Promise<string[]>;
  }

  // Legacy: send / sendAsync
  send(methodOrPayload: string | any, paramsOrCallback?: any[] | Function): any {
    if (typeof methodOrPayload === 'string') {
      return this.request({ method: methodOrPayload, params: paramsOrCallback as any[] });
    }
    // Legacy JSON-RPC payload
    const payload = methodOrPayload;
    if (typeof paramsOrCallback === 'function') {
      this.request({ method: payload.method, params: payload.params })
        .then((result) => paramsOrCallback(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch((err) => paramsOrCallback(err));
      return;
    }
    return this.request({ method: payload.method, params: payload.params });
  }

  sendAsync(payload: any, callback: Function): void {
    this.request({ method: payload.method, params: payload.params })
      .then((result) => callback(null, { id: payload.id, jsonrpc: '2.0', result }))
      .catch((err) => callback(err));
  }

  // EIP-1193: events
  on(event: string, handler: EventHandler): this {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event)!.add(handler);
    return this;
  }

  removeListener(event: string, handler: EventHandler): this {
    this._events.get(event)?.delete(handler);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this._events.delete(event);
    } else {
      this._events.clear();
    }
    return this;
  }

  private _emit(event: string, ...args: any[]) {
    this._events.get(event)?.forEach((handler) => {
      try { handler(...args); } catch (e) { console.error('[Auto-Wallet] event handler error:', e); }
    });
  }

  private _handleEvent(eventName: string, payload: any) {
    if (eventName === 'accountsChanged') {
      this._accounts = payload;
    } else if (eventName === 'chainChanged') {
      this._chainId = payload;
    }
    this._emit(eventName, payload);
  }
}

// --- Initialize ---

if (isProviderInjectionAllowed(window.location.href)) {
  initializeProvider();
}

function initializeProvider() {
const provider = new AutoWalletProvider();

// EIP-6963: announce provider
const providerInfo = {
  uuid: '10a4b7f8-3c2d-4e5a-9f6b-1d2e3f4a5b6c',
  name: 'Auto Wallet',
  icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAAAclBMVEVzcfJsbPJvbvZ4dfFdXPdfXvd4d/NfXveGhfJ+fPRnZPZnZvZgXfVnZfZXWPZsavVjYfVycvRfYPlnZvNQUPd2dfhmZfVmZPRgYPZeXfZhXvhiYfhbWvhkYfiJiPmsqvqVlPn8/P3b2vyCf/bn5vzFxPr6EbdXAAAAGnRSTlMAK50h9Oso0RZJwqtQaomikkH+SPr9gmKg4vB25/8AAATBSURBVGje7Vpte5s6DG1ZwTiAdwtO1tmiSbb0///F61ewwSQWffLpXn3oGAMd6xxJluleXv63vfZaFD+e6v9NyLJ6IgABIceyfpp/KqWQUh6eBtAIoQAEtE/yX5XCIsjX5wB01r8y8jSGtHcNw57HkLXxbq62pCx2ALQCnHspxzuZRIkEgB0IxeRe87RFUlWAWgcAXqZ6ZkinqkhnUlsCmEAluuDpxJAFIbSq60VR1z/V2jUCAB6AqfdkEISUpTJyYO0US1fqBwyCwDcUYqgRNk2NDAoQzCUpNEj1jyEHbAxoDSpXA3IW2rEt9AUQUkJgeIDWL37yLzXTUk6Ljq3BAjTgV+/y1F8m3e+oAwLR8sWkCKQRsB23C8rYbAphICkAipQ46EM+l2aiEggCWQYNQEyQnAOwrWFhyDIIqtgL4GtBe08AILOURE3Cq2CrQqYUELgspQCRe0eNLmWZlhhwOxKJAAzr0gDAJkCHVCAA8N1M+LaZYghQYwGDCQCmtNzKf4sOqCwl4B0GaX/HP5aidyOnd21kduwkqHEmMa2onSO3KvT9FjXTFWpyYgGAadCbAeys5GaqVASAQDQ7EnLQK/+bFIU25AMcIpJlrwLoxUMAxH7AAgXNDtP7LnpPaUQzYoGr3m0EAjhP14JweygCYJi8CNEr/qXx8Xm+HIVGid3bKse107qcVwee//Gq7M/5L3AI8KXgCvl25rhN3xdCwIeE8/VqMcYgAcR4+aNufnLcpk/XTCuSvizC9abd2VLhR+3++qVu4E5ZJHA8d2ePcD2b2NS/fN5MUIo25Jb5Pvmf9xcFdLl5BKv10ZJ25CrFkGcsxqMUdMbh8mUwLg7gdr19XaxW2A8Oh9BxH/w5Hj//jj5Z5XG0ibvjkEgShWv73qoWYM/56aUikG9vu76XLBG2W6pEzqXemlyA3Z8yuhIyrHzf61/P2BkA5DsfrCaAu5tas1MDM6M+FMCoTNi+ME48E0Ep0eyRouGAMDxEnZVFAVNYogacf00UriQYGoDzBhMEph3NQeTnbCX3AECfPcnjJXA85Qpx2umf88wYmn0A2vImYYIqs8jyTguEbyOocaDUE8HGE3knqq0sLQlrKf1RUdqyA9n4fpRDUhqg6aJSqilLPcdzxoDEizJZqIN+MiJLkZtRb2uAxg+g9dAxbV03GERKlv5zpu0VgCug6teh9AvWU2lzek0UTUYiLXYDt/fSppw3H+5+EjYsOyN/LDOL0tT5VzfT2Vsu7z4u5yEUrjf+1bzHkwjre+KxCNVbMIiagF+JxkyHsLqXp7J/7cPkTmlcpwNY3cwYuE/TYm1KEOcnARDGwIOYH3HkAYxgbIMcf3sBkHNoY+5V4jQ3f42crQSYlpB1ZKDuzZPPWr72CLFv90zuoe3DZo2eqOrfjogoT8MLHkWUd2jTecNtZxxmX5apSPCVOLmHNqpdmIdPQYqGZLkVLwDyD22dP0IWZsleZz43u2QEiPGrA15MABP/PMzPOF05avjSCDYhWMh8wFVczgYBe+apaiuyL4K4L0QkmR97f3NLZn7iPOVWdUcdavqNrCbcZY+Tgi/MzBvfORHWrAzYXkigfwc5fPs/SFR06IqPhRVFR7vv+/7P27+rg555c2/uZgAAAABJRU5ErkJggg==',
  rdns: 'com.auto-wallet',
};

function announceProvider() {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info: providerInfo, provider }),
    }),
  );
}

window.addEventListener('eip6963:requestProvider', announceProvider);
announceProvider();

// Check injectWindowEthereum setting to decide whether to inject window.ethereum
// The content script bridge (ISOLATED world) reads the setting and passes it via
// a custom event since inpage.ts (MAIN world) cannot access chrome.storage directly.
function injectAsWindowEthereum(reason: string) {
  const existing = (window as any).ethereum;
  const hadOtherProvider = !!existing && existing !== provider;
  (window as any).ethereum = provider;
  // Only impersonate MetaMask when we're the sole provider on the page.
  // If another wallet is present we leave `isMetaMask` false to avoid
  // conflicting with their detection.
  provider.isMetaMask = !hadOtherProvider;
  console.log(
    `[Auto Wallet] Injected as window.ethereum (${reason})` +
      (provider.isMetaMask ? ' [isMetaMask=true for legacy compat]' : ''),
  );
}

function handleInjectSetting(forceInject: boolean) {
  if (forceInject || !(window as any).ethereum) {
    injectAsWindowEthereum(forceInject ? 'force' : 'no existing provider');
  }
}

// Listen for the setting from the content script bridge
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== MSG_SOURCE) return;
  if (event.data?.type !== 'inject_setting') return;
  handleInjectSetting(event.data.forceInject === true);
});

// Fallback: if no setting is received within 100ms, use default behavior
const fallbackTimer = setTimeout(() => {
  if (!(window as any).ethereum) {
    injectAsWindowEthereum('fallback timer');
  }
}, 100);

window.addEventListener('message', (event) => {
  if (event.source === window && event.data?.source === MSG_SOURCE && event.data?.type === 'inject_setting') {
    clearTimeout(fallbackTimer);
  }
});

// Always expose under our own namespace
(window as any).autoWallet = provider;
}
