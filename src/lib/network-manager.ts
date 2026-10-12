// IO shell: chrome.storage + viem client management.
// Pure decision logic lives in network-manager.core.ts.

import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { type Network, PRESET_NETWORKS } from '../types/network';
import { getItem, setItem, updateItem, STORAGE_KEYS } from './storage';
import {
  findNetwork,
  validateCustomNetwork,
  upsertCustomNetwork,
  removeFromList,
  buildViemChain,
  computePresetsToSeed,
} from './network-manager.core';

// Re-export core functions for backward compatibility
export { buildViemChain, findNetwork, mergeNetworks } from './network-manager.core';

let activeChainId: number = 1;
let clientCache: Map<number, PublicClient> = new Map();

// --- Helpers ---

function buildClient(network: Network): PublicClient {
  return createPublicClient({ transport: http(network.rpcUrl) });
}

// --- Public API ---

/**
 * Seed missing presets into the user's network list. Safe to call repeatedly:
 *  - presets the user already added stay untouched
 *  - presets the user deleted are tracked in SEEDED_PRESET_IDS and don't return
 *  - new presets shipped in an update get appended
 */
export async function seedPresetsIfNeeded(): Promise<void> {
  const seededIds = (await getItem<number[]>(STORAGE_KEYS.SEEDED_PRESET_IDS)) ?? [];
  let newSeededIds: number[] | null = null;
  // Same queue as add/update/remove, so a network added during startup is kept.
  await updateItem<Network[]>(STORAGE_KEYS.NETWORKS, (stored) => {
    const result = computePresetsToSeed(stored ?? [], seededIds, PRESET_NETWORKS);
    if (!result.changed) return stored ?? [];
    newSeededIds = result.seededIds;
    return result.networks;
  });
  // Written after the list, as before: a crash in between re-seeds instead of losing presets.
  if (newSeededIds) await setItem(STORAGE_KEYS.SEEDED_PRESET_IDS, newSeededIds);
}

export async function getAllNetworks(): Promise<Network[]> {
  return (await getItem<Network[]>(STORAGE_KEYS.NETWORKS)) ?? [];
}

export async function getActiveNetwork(): Promise<Network> {
  const stored = await getItem<number>(STORAGE_KEYS.ACTIVE_CHAIN_ID);
  if (stored !== null) activeChainId = stored;
  const networks = await getAllNetworks();
  const match = findNetwork(networks, activeChainId);
  if (match) return match;
  // Fallback: first stored network, then the first preset (Ethereum mainnet) if
  // somehow the user has zero networks (e.g. all deleted).
  const first = networks[0] ?? PRESET_NETWORKS[0];
  if (!first) throw new Error('No networks configured');
  return first;
}

export async function switchNetwork(chainId: number): Promise<Network> {
  const networks = await getAllNetworks();
  const network = findNetwork(networks, chainId);
  if (!network) throw new Error(`Unknown chainId: ${chainId}`);
  activeChainId = chainId;
  await setItem(STORAGE_KEYS.ACTIVE_CHAIN_ID, chainId);
  return network;
}

/** Add a brand-new network. Throws if a network with this chainId already exists. */
export async function addCustomNetwork(network: Network): Promise<void> {
  await updateItem<Network[]>(STORAGE_KEYS.NETWORKS, (all) => {
    validateCustomNetwork(all ?? [], network);
    return upsertCustomNetwork(all ?? [], network);
  });
  clientCache.delete(network.chainId);
}

/** Update an existing network in place (used by the edit form). */
export async function updateNetwork(network: Network): Promise<void> {
  await updateItem<Network[]>(STORAGE_KEYS.NETWORKS, (all) => {
    if (!findNetwork(all ?? [], network.chainId)) {
      throw new Error(`Chain ${network.chainId} not found`);
    }
    return upsertCustomNetwork(all ?? [], network);
  });
  clientCache.delete(network.chainId);
}

export async function removeCustomNetwork(chainId: number): Promise<void> {
  const filtered = await updateItem<Network[]>(STORAGE_KEYS.NETWORKS, (all) => removeFromList(all ?? [], chainId));
  clientCache.delete(chainId);
  if (activeChainId === chainId) {
    // Pick the first remaining network if any, otherwise fall back to Ethereum.
    const next = filtered[0]?.chainId ?? PRESET_NETWORKS[0]?.chainId ?? 1;
    await switchNetwork(next).catch(() => {
      // If even the fallback is gone, just record the id; getActiveNetwork
      // handles the empty case.
      activeChainId = next;
      return setItem(STORAGE_KEYS.ACTIVE_CHAIN_ID, next);
    });
  }
}

export async function getClient(chainId?: number): Promise<PublicClient> {
  const id = chainId ?? await getActiveChainId();
  if (clientCache.has(id)) return clientCache.get(id)!;
  const networks = await getAllNetworks();
  const network = findNetwork(networks, id);
  if (!network) throw new Error(`Unknown chainId: ${id}`);
  const client = buildClient(network);
  clientCache.set(id, client);
  return client;
}

export async function getActiveChainId(): Promise<number> {
  const stored = await getItem<number>(STORAGE_KEYS.ACTIVE_CHAIN_ID);
  if (stored !== null) activeChainId = stored;
  return activeChainId;
}

/** Create a WalletClient configured for the active network. */
export async function getWalletClient(account: PrivateKeyAccount): Promise<WalletClient> {
  const network = await getActiveNetwork();
  return createWalletClient({
    account,
    transport: http(network.rpcUrl),
  });
}
