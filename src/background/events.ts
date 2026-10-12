// Broadcast EIP-1193 events to all tabs

import { MSG_SOURCE } from '../types/messages';

/** Broadcast an event to all tabs' content scripts, which forward to inpage provider. */
function broadcast(eventName: string, payload: unknown): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, {
        source: MSG_SOURCE,
        type: 'event',
        eventName,
        payload,
      }).catch(() => {}); // ignore tabs without content script
    }
  });
}

/**
 * Tell every tab the account state changed. The payload is deliberately empty:
 * each tab's content script re-asks eth_accounts, so a tab only learns the
 * address if its own origin is connected.
 */
export function emitAccountsChanged(): void {
  broadcast('accountsChanged', null);
}

export function emitChainChanged(chainIdHex: string): void {
  broadcast('chainChanged', chainIdHex);
}
