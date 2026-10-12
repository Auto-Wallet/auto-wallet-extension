// Manages the unlock popup window triggered by dApp connection attempts

import { MSG_SOURCE } from '../types/messages';
import { createPopupWindow } from './window-utils';
import { isExtensionPageSender } from '../lib/sender-trust';

interface PendingUnlock {
  resolve: (unlocked: boolean) => void;
}

let pendingUnlock: PendingUnlock | null = null;
let unlockWindowId: number | null = null;

/** The unlock popup this worker opened, if any. */
export function liveUnlockWindowId(): number | null {
  return unlockWindowId;
}

/** Open an unlock popup and wait for user to enter password. Returns true if unlocked. */
export function requestUnlock(origin: string): Promise<boolean> {
  // If there's already an unlock window open, focus it
  if (unlockWindowId !== null) {
    chrome.windows.update(unlockWindowId, { focused: true });
    // Return a new promise that shares the same pending resolve
    return new Promise((resolve) => {
      const prev = pendingUnlock;
      pendingUnlock = {
        resolve: (ok) => {
          prev?.resolve(ok);
          resolve(ok);
        },
      };
    });
  }

  return new Promise((resolve) => {
    pendingUnlock = { resolve };

    const params = new URLSearchParams({ origin });
    const url = chrome.runtime.getURL(`unlock.html?${params}`);

    createPopupWindow(url, 360, 480).then((window) => {
      if (!window) {
        pendingUnlock = null;
        resolve(false);
        return;
      }

      unlockWindowId = window.id!;

      const onRemoved = (windowId: number) => {
        if (windowId === unlockWindowId) {
          chrome.windows.onRemoved.removeListener(onRemoved);
          unlockWindowId = null;
          if (pendingUnlock) {
            pendingUnlock.resolve(false);
            pendingUnlock = null;
          }
        }
      };
      chrome.windows.onRemoved.addListener(onRemoved);
    });
  });
}

// Listen for unlock responses
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.source !== MSG_SOURCE) return;
  if (message.type !== 'unlock_response') return;
  if (!isExtensionPageSender(sender, chrome.runtime.id, ['unlock.html'])) return;

  if (pendingUnlock) {
    const p = pendingUnlock;
    pendingUnlock = null;
    p.resolve(message.success === true);
  }

  // Close the unlock window
  if (unlockWindowId !== null) {
    chrome.windows.remove(unlockWindowId);
    unlockWindowId = null;
  }
});
