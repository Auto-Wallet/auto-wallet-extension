// Shared transaction-receipt poller used by every send path: manual sends,
// dApp sends, and speed-up / cancel replacements.

import * as networkManager from '../lib/network-manager';
import * as txLogger from '../lib/tx-logger';
import { notifyTx } from '../lib/notify';

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
 * Fire-and-forget: returns immediately and updates the log out of band. A
 * timeout (or an untrackable, dropped tx) leaves the row pending — the same
 * outcome as the old poll giving up after its attempt budget.
 */
export function pollTxReceipt(
  logId: string,
  chainId: number,
  hash: string,
  origin: string,
  autoSigned: boolean,
  explorerUrl?: string,
): void {
  void (async () => {
    try {
      const client = await networkManager.getClient(chainId);
      const receipt = await client.waitForTransactionReceipt({
        hash: hash as `0x${string}`,
        pollingInterval: 5000,
        timeout: 300_000, // ~5 min, matching the old 60 × 5s attempt budget
      });
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
    } catch {
      // Timed out, or the tx could not be tracked (e.g. dropped from the
      // mempool) — leave the row pending, same as the old poll giving up.
    }
  })();
}
