import { MSG_SOURCE, genId, type RpcRequest, type RpcResponse } from '../types/messages';
import * as keyManager from '../lib/key-manager';
import * as networkManager from '../lib/network-manager';
import * as whitelist from '../lib/whitelist';
import * as tokenManager from '../lib/token-manager';
import * as txLogger from '../lib/tx-logger';
import { handleRpcMethod } from './rpc-handler';
import { handlePopupAction } from './popup-handler';
import './unlock-manager'; // register unlock message listener
import './confirm-manager'; // register confirm message listener
import './ledger-picker-manager'; // register Ledger picker listener
import { isExtensionPageSender } from '../lib/sender-trust';
import { checkPendingTxs, TX_RESUME_ALARM } from './tx-poller';
import { closeOrphanedPopups } from './orphan-popups';
import { liveConfirmations } from './confirm-manager';
import { liveUnlockWindowId } from './unlock-manager';

// --- Message listener ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source !== MSG_SOURCE) return false;
  // Only these two types are answered here; other types (confirm_response,
  // unlock_response, …) have their own listeners. Keeping the channel open for
  // them would leave the sender waiting forever.
  if (message.type !== 'rpc_request' && message.type !== 'popup_request') return false;
  // SECURITY: popup actions (export key, add rules, delete wallet, …) are only
  // for our own extension pages. Content scripts share our extension id, so
  // check the page URL rather than sender.id alone.
  if (message.type === 'popup_request' && !isExtensionPageSender(sender, chrome.runtime.id)) {
    console.warn('[Auto-Wallet] Ignored popup_request from untrusted sender', sender.url);
    return false;
  }

  const handleAsync = async () => {
    try {
      if (message.type === 'rpc_request') {
        const req = message as RpcRequest;
        // SECURITY: Derive origin from sender (Chrome-verified), never trust message payload
        const trustedOrigin = sender.origin ?? (sender.url ? new URL(sender.url).origin : null);
        if (!trustedOrigin) throw new Error('Cannot determine request origin');
        const result = await handleRpcMethod(req.method, req.params ?? [], trustedOrigin, sender);
        const response: RpcResponse = {
          source: MSG_SOURCE,
          id: genId(),
          type: 'rpc_response',
          requestId: req.id,
          result,
        };
        sendResponse(response);
      } else if (message.type === 'popup_request') {
        const result = await handlePopupAction(message.action, message.payload);
        sendResponse({
          source: MSG_SOURCE,
          id: genId(),
          type: 'popup_response',
          requestId: message.id,
          result,
        });
      }
    } catch (err: any) {
      sendResponse({
        source: MSG_SOURCE,
        id: genId(),
        type: message.type === 'rpc_request' ? 'rpc_response' : 'popup_response',
        requestId: message.id,
        error: message.type === 'rpc_request'
          ? { code: err.code ?? -32603, message: err.message }
          : err.message,
      });
    }
  };

  handleAsync();
  return true; // keep channel open for async response
});

// Service worker install
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Auto-Wallet] Extension installed');
  // Seed preset networks on install/update so new chainIds shipped in a
  // release show up without a fresh-install reset.
  networkManager.seedPresetsIfNeeded().catch((err) => {
    console.warn('[Auto-Wallet] Failed to seed preset networks:', err);
  });
});

// MV3 service workers can be started for many reasons (alarms, messages, etc.)
// Seed on every cold start as well — the function is a no-op when nothing new
// needs to be added.
networkManager.seedPresetsIfNeeded().catch((err) => {
  console.warn('[Auto-Wallet] Failed to seed preset networks:', err);
});

// One-time migration of the legacy Address Book into watch-only accounts.
// Idempotent — runs whenever the SW wakes up, then the storage key is gone.
keyManager.migrateAddressBookToWatchOnlyOnce().catch((err) => {
  console.warn('[Auto-Wallet] Failed to migrate address book:', err);
});

// A previous worker instance may have died with work in flight: confirm popups
// whose dApp request is gone, and sends still waiting for a receipt.
closeOrphanedPopups(() => {
  const live = liveConfirmations();
  const unlockWindow = liveUnlockWindowId();
  if (unlockWindow !== null) live.windowIds.add(unlockWindow);
  return { requestIds: live.ids, windowIds: live.windowIds };
}).catch((err) => {
  console.warn('[Auto-Wallet] Failed to close orphaned popups:', err);
});
checkPendingTxs().catch((err) => {
  console.warn('[Auto-Wallet] Failed to resume pending transactions:', err);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TX_RESUME_ALARM) return;
  checkPendingTxs().catch((err) => {
    console.warn('[Auto-Wallet] Pending transaction check failed:', err);
  });
});
