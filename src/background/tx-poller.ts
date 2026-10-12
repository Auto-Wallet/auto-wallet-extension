// Shared transaction-receipt poller used by every send path: manual sends,
// dApp sends, and speed-up / cancel replacements.

import { TransactionReceiptNotFoundError, type TransactionReceipt } from 'viem';
import * as networkManager from '../lib/network-manager';
import * as txLogger from '../lib/tx-logger';
import { notifyTx } from '../lib/notify';
import { selectResumableTxs, receiptCandidates } from '../lib/tx-resume.core';
import { acquireKeepAlive } from './keepalive';

/** Periodic alarm that re-checks pending rows if the worker was stopped mid-poll. */
export const TX_RESUME_ALARM = 'aw-tx-resume';

// Log ids with a live waitForTransactionReceipt in this worker.
const polling = new Set<string>();

/** Write the mined result into the history row and fire the result notification. */
async function finalize(
  logId: string,
  receipt: TransactionReceipt,
  origin: string,
  autoSigned: boolean,
  explorerUrl?: string,
): Promise<void> {
  const status = receipt.status === 'success' ? 'confirmed' : 'failed';
  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.effectiveGasPrice;
  const fee = gasUsed !== undefined && effectiveGasPrice !== undefined
    ? gasUsed * effectiveGasPrice
    : null;
  const minedHash = receipt.transactionHash;
  await txLogger.updateLogEntry(logId, {
    // Point the row at the hash that actually mined. For a normal send this
    // equals `hash`; for a replacement where the competing tx won, it
    // corrects a link that would otherwise be permanently broken.
    hash: minedHash,
    status,
    gasUsed: gasUsed?.toString(),
    effectiveGasPrice: effectiveGasPrice?.toString(),
    feeWei: fee?.toString(),
  });
  notifyTx(minedHash, origin, autoSigned, status, explorerUrl);
}

/**
 * Watch a broadcast transaction until it mines (or times out), then mark its
 * history row confirmed/failed and fire the result notification.
 *
 * Uses viem's waitForTransactionReceipt, which natively follows same-nonce
 * replacements: after a Speed Up / Revoke the original and the replacement
 * compete at the same nonce, and whichever the node actually mines is the one
 * we record. We write `receipt.transactionHash` back to the row so its explorer
 * link always points at the tx that landed — even when the *other* hash won (the
 * old fixed-hash poll would sit pending forever and leave a dead link).
 *
 * Fire-and-forget: returns immediately and updates the log out of band. The
 * worker is kept alive while polling; if it is stopped anyway (browser
 * restart, extension update), the TX_RESUME_ALARM check picks the row up again.
 */
export function pollTxReceipt(
  logId: string,
  chainId: number,
  hash: string,
  origin: string,
  autoSigned: boolean,
  explorerUrl?: string,
): void {
  polling.add(logId);
  const release = acquireKeepAlive();
  ensureResumeAlarm();
  void (async () => {
    try {
      const client = await networkManager.getClient(chainId);
      const receipt = await client.waitForTransactionReceipt({
        hash: hash as `0x${string}`,
        pollingInterval: 5000,
        timeout: 300_000, // ~5 min, matching the old 60 × 5s attempt budget
      });
      await finalize(logId, receipt, origin, autoSigned, explorerUrl);
    } catch (err) {
      // Timed out, or the tx could not be tracked (e.g. dropped from the
      // mempool) — leave the row pending; the resume alarm keeps checking.
      console.warn(`[Auto-Wallet] Receipt poll for ${hash} ended without a result:`, err);
    } finally {
      polling.delete(logId);
      release();
    }
  })();
}

function ensureResumeAlarm(): void {
  chrome.alarms.create(TX_RESUME_ALARM, { periodInMinutes: 1 });
}

/**
 * One-shot receipt check for every recent pending row nobody is polling right
 * now. Runs at worker startup and on TX_RESUME_ALARM, so a send whose poll
 * died with the worker still gets its final status and notification.
 */
export async function checkPendingTxs(): Promise<void> {
  const log = await txLogger.getLog();
  const todo = selectResumableTxs(log, Date.now(), polling);
  const networks = await networkManager.getAllNetworks();
  let stillPending = polling.size;

  for (const entry of todo) {
    const network = networks.find((n) => n.chainId === entry.chainId);
    if (!network) continue; // chain was removed; nothing to poll
    const client = await networkManager.getClient(entry.chainId);
    // Same-nonce txs: at most one of them can mine, so the first receipt found is the result.
    let receipt: TransactionReceipt | null = null;
    for (const hash of receiptCandidates(entry)) {
      try {
        receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
        break;
      } catch (err) {
        if (!(err instanceof TransactionReceiptNotFoundError)) {
          console.warn(`[Auto-Wallet] Receipt check for ${hash} failed:`, err);
        }
      }
    }
    if (!receipt) {
      stillPending++;
      continue;
    }
    await finalize(entry.id, receipt, entry.origin, entry.autoSigned, network.blockExplorerUrl);
  }

  if (stillPending > 0) {
    ensureResumeAlarm();
  } else {
    await chrome.alarms.clear(TX_RESUME_ALARM);
  }
}
