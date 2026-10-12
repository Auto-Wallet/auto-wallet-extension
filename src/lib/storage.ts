// Thin wrapper over chrome.storage.local for typed access

// Resolved on every call (not captured at import) so tests can swap in a fake
// `chrome` global after this module has loaded.
function storage(): chrome.storage.LocalStorageArea {
  return chrome.storage.local;
}

export async function getItem<T>(key: string): Promise<T | null> {
  const result = await storage().get(key);
  return (result[key] as T) ?? null;
}

export async function setItem<T>(key: string, value: T): Promise<void> {
  await storage().set({ [key]: value });
}

/** Write several keys in one storage call, so they land together or not at all. */
export async function setItems(items: Record<string, unknown>): Promise<void> {
  await storage().set(items);
}

export async function removeItem(key: string): Promise<void> {
  await storage().remove(key);
}

// Storage keys
export const STORAGE_KEYS = {
  ACCOUNTS: 'accounts',            // StoredAccount[]
  ACTIVE_ACCOUNT_ID: 'active_account_id',
  PASSWORD_VERIFIER: 'password_verifier', // legacy v1: EncryptedData of fixed plaintext, replaced by VAULT
  VAULT: 'vault',                  // VaultRecord (v2): KDF params + verifier for the vault key
  BIOMETRIC: 'biometric_unlock',   // BiometricRecord: vault key sealed by the Touch ID (WebAuthn PRF) key
  ENCRYPTED_KEY: 'encrypted_private_key', // legacy single-key (migration)
  NETWORKS: 'networks',
  ACTIVE_CHAIN_ID: 'active_chain_id',
  /** Preset chainIds we've already offered to seed. Tracking this lets a
   *  user-deleted preset stay deleted across restarts and across upgrades that
   *  add new presets. */
  SEEDED_PRESET_IDS: 'seeded_preset_ids',
  WHITELIST_RULES: 'whitelist_rules',
  TOKENS: 'tokens',
  TX_LOG: 'tx_log',
  SETTINGS: 'settings',
  PRICES_CACHE: 'prices_cache',
  /** Chain IDs the user has starred on the Swap page's token picker. */
  SWAP_STARRED_CHAINS: 'swap_starred_chains',
  /** Chain IDs the user has pinned to the top on the Networks (Chains) page. */
  STARRED_NETWORKS: 'starred_networks',
  /** ConnectedSite[] — sites allowed to see the account and request signatures. */
  CONNECTED_SITES: 'connected_sites',
  /** Set once legacy origins (rules, history) were seeded as connected sites. */
  CONNECTED_SITES_SEEDED: 'connected_sites_seeded',
} as const;
