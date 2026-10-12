import { MSG_SOURCE, genId } from '../types/messages';
import { isExtensionPageSender } from '../lib/sender-trust';

interface LedgerPickerResult {
  selected: Array<{ address: string; derivationPath: string; label?: string }>;
}

const pendingPickers = new Map<string, {
  resolve: (result: LedgerPickerResult) => void;
  reject: (error: Error) => void;
  windowId?: number;
}>();

export function openLedgerPickerWindow(): Promise<LedgerPickerResult> {
  const requestId = genId();
  const url = chrome.runtime.getURL(`ledger-picker.html?id=${requestId}`);

  return new Promise((resolve, reject) => {
    pendingPickers.set(requestId, { resolve, reject });

    chrome.windows.create(
      { url, type: 'popup', state: 'maximized', focused: true },
      (window) => {
        const pending = pendingPickers.get(requestId);
        if (!pending) return;
        if (!window?.id) {
          pendingPickers.delete(requestId);
          reject(new Error('Could not open Ledger picker window'));
          return;
        }
        pending.windowId = window.id;

        const onRemoved = (windowId: number) => {
          if (windowId !== window.id) return;
          chrome.windows.onRemoved.removeListener(onRemoved);
          const current = pendingPickers.get(requestId);
          if (!current) return;
          pendingPickers.delete(requestId);
          current.reject(new Error('Ledger picker was closed'));
        };
        chrome.windows.onRemoved.addListener(onRemoved);
      },
    );
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.source !== MSG_SOURCE || message.type !== 'ledger_picker_response') return false;
  if (!isExtensionPageSender(sender, chrome.runtime.id, ['ledger-picker.html'])) return false;

  const pending = pendingPickers.get(message.requestId);
  if (!pending) return false;
  pendingPickers.delete(message.requestId);

  if (pending.windowId) {
    chrome.windows.remove(pending.windowId).catch(() => undefined);
  }

  if (message.error) {
    pending.reject(new Error(message.error));
  } else {
    pending.resolve({ selected: message.selected ?? [] });
  }

  return false;
});
