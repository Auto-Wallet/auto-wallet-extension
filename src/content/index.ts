// Content script: bridge between inpage provider (MAIN world) and background service worker
// Runs in ISOLATED world — can access both chrome.runtime and window messages

import { MSG_SOURCE, genId, type RpcResponse } from '../types/messages';
import { isProviderInjectionAllowed } from '../lib/injection-policy';
import type { WalletSettings } from '../types/settings';

// True while this content script's link to the extension is still valid.
// After the user reloads the extension in chrome://extensions, the old content
// script keeps running in already-open tabs but every chrome.* call throws
// "Extension context invalidated". Guarding every entrypoint lets us no-op
// instead of spewing errors into the page console.
function isExtensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

if (isProviderInjectionAllowed(window.location.href)) {
  // Forward injectWindowEthereum setting to inpage.ts (MAIN world)
  // inpage.ts cannot access chrome.storage, so we read and relay it.
  if (isExtensionAlive()) {
    try {
      chrome.storage.local.get('settings', (result) => {
        if (chrome.runtime.lastError) return;
        const settings = result.settings as Partial<WalletSettings> | undefined;
        const forceInject = settings?.injectWindowEthereum === true;
        window.postMessage({
          source: MSG_SOURCE,
          type: 'inject_setting',
          forceInject,
        }, '*');
      });
    } catch { /* context died between check and call */ }
  }

  // Forward messages from page (inpage.js) to background service worker
  // SECURITY: Never trust page-supplied origin — overwrite with real origin from ISOLATED world
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== MSG_SOURCE) return;
    if (event.data?.type !== 'rpc_request') return;
    if (!isExtensionAlive()) return;

    const sanitized = { ...event.data, origin: window.location.origin };
    try {
      chrome.runtime.sendMessage(sanitized, (response: RpcResponse) => {
        // Swallow callback errors so the page console stays clean.
        if (chrome.runtime.lastError) return;
        window.postMessage(response, '*');
      });
    } catch { /* extension reloaded mid-flight */ }
  });

  // Forward events from background to page (e.g. accountsChanged, chainChanged)
  if (isExtensionAlive()) {
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.source !== MSG_SOURCE) return;
        if (message.type !== 'event') return;
        if (message.eventName === 'accountsChanged') {
          forwardAccountsForThisOrigin();
          return;
        }
        window.postMessage(message, '*');
      });
    } catch { /* extension reloaded before listener registered */ }
  }

  // accountsChanged is broadcast to every tab without an address. Ask
  // eth_accounts as this page, so the page only sees the account when its
  // origin is connected.
  function forwardAccountsForThisOrigin(): void {
    if (!isExtensionAlive()) return;
    const request = {
      source: MSG_SOURCE,
      id: genId(),
      type: 'rpc_request',
      method: 'eth_accounts',
      params: [],
      origin: window.location.origin,
    };
    try {
      chrome.runtime.sendMessage(request, (response: RpcResponse) => {
        if (chrome.runtime.lastError) return;
        if (!response || response.error) return;
        window.postMessage({
          source: MSG_SOURCE,
          type: 'event',
          eventName: 'accountsChanged',
          payload: response.result,
        }, '*');
      });
    } catch { /* extension reloaded mid-flight */ }
  }
}
