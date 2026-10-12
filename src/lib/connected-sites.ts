// IO shell for per-site connection permissions. Logic lives in connected-sites.core.ts.

import { getItem, setItems, updateItem, STORAGE_KEYS } from './storage';
import { addSite, removeSite, isConnected, legacyOriginsToSeed, type ConnectedSite } from './connected-sites.core';
import type { WhitelistRule } from '../types/whitelist';
import type { TxLogEntry } from './tx-logger';

export type { ConnectedSite } from './connected-sites.core';
export { siteOrigin } from './connected-sites.core';

async function readSites(): Promise<ConnectedSite[]> {
  return (await getItem<ConnectedSite[]>(STORAGE_KEYS.CONNECTED_SITES)) ?? [];
}

// Every read waits for the one-time upgrade seeding, so a dApp request that
// races the worker's startup can't see a half-migrated (empty) list.
let seeding: Promise<void> | null = null;
function ensureSeeded(): Promise<void> {
  if (!seeding) {
    seeding = seedConnectedSitesOnce().catch((err) => {
      seeding = null; // retry on the next read
      throw err;
    });
  }
  return seeding;
}

export async function getConnectedSites(): Promise<ConnectedSite[]> {
  await ensureSeeded();
  return readSites();
}

export async function isSiteConnected(origin: string): Promise<boolean> {
  return isConnected(await getConnectedSites(), origin);
}

export async function connectSite(origin: string): Promise<void> {
  await ensureSeeded();
  await updateItem<ConnectedSite[]>(STORAGE_KEYS.CONNECTED_SITES, (sites) => addSite(sites ?? [], origin, Date.now()));
}

export async function disconnectSite(origin: string): Promise<void> {
  await ensureSeeded();
  await updateItem<ConnectedSite[]>(STORAGE_KEYS.CONNECTED_SITES, (sites) => removeSite(sites ?? [], origin));
}

/**
 * One-time upgrade step: wallets from before connections existed treat the
 * sites in their whitelist rules and tx history as already connected.
 */
async function seedConnectedSitesOnce(): Promise<void> {
  if (await getItem<boolean>(STORAGE_KEYS.CONNECTED_SITES_SEEDED)) return;
  const rules = (await getItem<WhitelistRule[]>(STORAGE_KEYS.WHITELIST_RULES)) ?? [];
  const log = (await getItem<TxLogEntry[]>(STORAGE_KEYS.TX_LOG)) ?? [];
  let sites = await readSites();
  const now = Date.now();
  for (const origin of legacyOriginsToSeed(rules, log)) {
    sites = addSite(sites, origin, now);
  }
  await setItems({
    [STORAGE_KEYS.CONNECTED_SITES]: sites,
    [STORAGE_KEYS.CONNECTED_SITES_SEEDED]: true,
  });
}

/** Test-only: forget that seeding ran in this worker, so the next read checks storage again. */
export function resetSeedingForTests(): void {
  seeding = null;
}
