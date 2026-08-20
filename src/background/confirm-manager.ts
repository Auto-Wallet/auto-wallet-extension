// Manages the confirmation popup window for non-whitelisted requests

import { MSG_SOURCE, genId } from '../types/messages';
import { addRule } from '../lib/whitelist';
import type { WhitelistRule } from '../types/whitelist';
import { createPopupWindow } from './window-utils';
import type { SimulationPreview } from './bcs-simulation';
import { createConfirmQueue } from './confirm-queue';
import { addLockListener } from '../lib/key-manager';

export interface FeeOverride {
  type: 'eip1559' | 'legacy';
  gas: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  gasPrice: string | null;
}

/**
 * When the active account is a Ledger, the confirm popup performs the
 * actual signing locally (WebHID is unavailable in the service worker).
 * `signedRawTx` is set for transactions, `signature` for sign-message flows.
 */
export interface ConfirmResult {
  approved: boolean;
  feeOverride?: FeeOverride | null;
  txDataOverride?: `0x${string}` | null;
  signedRawTx?: `0x${string}` | null;
  signature?: `0x${string}` | null;
}

const confirmQueue = createConfirmQueue<ConfirmResult>();

export interface SerializedTxJSON {
  type: 'eip1559' | 'legacy';
  to: `0x${string}`;
  value: string;
  data?: `0x${string}`;
  gas: string;
  nonce: number;
  chainId: number;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

export interface LedgerConfirmContext {
  derivationPath: string;
  // For eth_sendTransaction: the prepared unsigned tx (popup signs, re-serializes, returns rawTx)
  txJson?: SerializedTxJSON;
  // For personal_sign: hex of the raw message bytes
  messageHex?: string;
  // For eth_signTypedData_v4: 32-byte hashes (popup uses the hashed-message API)
  domainSeparator?: `0x${string}`;
  hashStructMessage?: `0x${string}`;
}

export interface ConfirmRequest {
  id: string;
  method: string;
  origin: string;
  params: unknown;
  signerAddress?: string;
  chainId?: number;
  chainName?: string;
  nativeSymbol?: string;
  ledger?: LedgerConfirmContext;
  simulation?: SimulationPreview;
  /** True when simulation is still running; popup should render a skeleton until
   *  the result lands at `confirm_${id}_simulation` in session storage. */
  simulationPending?: boolean;
}

export interface RequestUserConfirmationOptions {
  /** When provided, the popup opens immediately without waiting; the resolved
   *  simulation is persisted to `confirm_${id}_simulation` for the popup to
   *  pick up via chrome.storage.onChanged. */
  simulationPromise?: Promise<SimulationPreview>;
}

function simulationKey(id: string): string {
  return `confirm_${id}_simulation`;
}

async function cleanupRequest(id: string): Promise<void> {
  await chrome.storage.session.remove([`confirm_${id}`, simulationKey(id)]);
}

/** Reject every in-flight confirmation and close its popup. Called on wallet lock. */
export async function rejectAllPendingConfirmations(): Promise<void> {
  const { ids, windowIds } = confirmQueue.rejectAll();
  await Promise.all([
    ...ids.map((id) => cleanupRequest(id)),
    ...windowIds.map((windowId) => chrome.windows.remove(windowId).catch(() => undefined)),
  ]);
}

addLockListener(rejectAllPendingConfirmations);

/** Open a confirmation popup and wait for user to approve or reject. */
export function requestUserConfirmation(
  request: ConfirmRequest,
  options?: RequestUserConfirmationOptions,
): Promise<ConfirmResult> {
  return new Promise(async (resolve) => {
    confirmQueue.add(request.id, resolve);

    const storedRequest: ConfirmRequest = options?.simulationPromise
      ? { ...request, simulationPending: true, simulation: undefined }
      : request;

    // Store request data in session storage instead of URL query string
    // to avoid URL length limits with large calldata
    await chrome.storage.session.set({ [`confirm_${request.id}`]: storedRequest });

    // Push the simulation result asynchronously once it resolves. Don't fail the
    // confirm flow if the API errors — simulateTx already converts errors into
    // a SimulationPreview with status='unavailable'.
    if (options?.simulationPromise) {
      options.simulationPromise
        .then((simulation) => chrome.storage.session.set({ [simulationKey(request.id)]: simulation }))
        .catch(() => {
          chrome.storage.session.set({
            [simulationKey(request.id)]: {
              status: 'unavailable',
              error: 'Simulation failed unexpectedly.',
              changes: [],
            } satisfies SimulationPreview,
          });
        });
    }

    const url = chrome.runtime.getURL(`confirm.html?id=${request.id}`);

    const window = await createPopupWindow(url, 360, 740);

    // Auto-lock (or another cancel) may have drained the queue while the
    // popup was opening. Close the leftover window and do not re-resolve.
    if (!confirmQueue.has(request.id)) {
      await cleanupRequest(request.id);
      if (window?.id != null) {
        chrome.windows.remove(window.id).catch(() => undefined);
      }
      return;
    }

    if (!window) {
      await cleanupRequest(request.id);
      const pending = confirmQueue.take(request.id);
      pending?.resolve({ approved: false });
      return;
    }

    if (!confirmQueue.setWindowId(request.id, window.id!)) {
      await cleanupRequest(request.id);
      chrome.windows.remove(window.id!).catch(() => undefined);
      return;
    }

    const onRemoved = (windowId: number) => {
      if (windowId === window.id) {
        chrome.windows.onRemoved.removeListener(onRemoved);
        cleanupRequest(request.id);
        const pending = confirmQueue.take(request.id);
        if (pending) {
          pending.resolve({ approved: false });
        }
      }
    };
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

// Listen for responses from the confirmation page
chrome.runtime.onMessage.addListener((message) => {
  if (message?.source !== MSG_SOURCE) return;
  if (message.type !== 'confirm_response') return;

  const pending = confirmQueue.take(message.requestId);
  if (pending) {
    cleanupRequest(message.requestId);
    pending.resolve({
      approved: message.approved === true,
      feeOverride: message.feeOverride ?? null,
      txDataOverride: message.txDataOverride ?? null,
      signedRawTx: message.signedRawTx ?? null,
      signature: message.signature ?? null,
    });

    // If user toggled "Trust this site", add origin to whitelist
    if (message.approved && message.addToWhitelist && message.origin) {
      let domain = message.origin;
      try { domain = new URL(message.origin).origin; } catch {}

      const rule: WhitelistRule = {
        id: genId(),
        label: `Trust: ${domain}`,
        enabled: true,
        origin: domain,
        contractAddress: null,
        methodSig: null,
        maxValueEth: null,
        maxGasLimit: null,
        chainId: null,
        createdAt: Date.now(),
      };
      addRule(rule);
    }
  }
});
