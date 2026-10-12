// IO shell: chrome.storage + session management.
// Pure decision logic lives in key-manager.core.ts.
//
// Storage format v2: one AES key (the "vault key") is derived from the master
// password and seals every private account. chrome.storage.session keeps only
// that key's bytes so the worker can restart without asking again — never the
// password itself. Wallets in the v1 format (each account encrypted with its
// own password-derived key) are migrated on their first unlock.

import { generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts';
import {
  decrypt,
  createVaultKey,
  deriveVaultKey,
  importVaultKey,
  biometricWrapKey,
  seal,
  unseal,
  type EncryptedData,
  type VaultKey,
} from './crypto';
import { getItem, setItem, setItems, removeItem, STORAGE_KEYS } from './storage';
import { type WalletSettings, DEFAULT_SETTINGS } from '../types/settings';
import { getAddress as toChecksumAddress, isAddress } from 'viem';
import {
  decryptToAccount,
  shouldAutoLock,
  autoLockMsFromMinutes,
  resolveActiveAccount,
  nextAccountLabel,
  toAccountInfo,
  isLedger,
  isWatchOnly,
  canSign,
  PASSWORD_VERIFIER_PLAINTEXT,
  type AccountSource,
  type StoredAccount,
  type AccountInfo,
  type SessionData,
  type VaultRecord,
  type BiometricRecord,
  type BiometricStatus,
} from './key-manager.core';

// Re-export types for backward compatibility
export type { StoredAccount, AccountInfo } from './key-manager.core';

// --- In-memory state (rebuilt from session storage on SW wake) ---
// Only private accounts hold a viem account in memory; ledger accounts are
// metadata-only at the background layer (signing happens in UI contexts).
let unlockedAccounts: Map<string, PrivateKeyAccount> = new Map();
let activeAccountId: string | null = null;
let vaultKey: CryptoKey | null = null;
let vaultKeyRaw: string | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivity: number = Date.now();

type LockListener = () => void | Promise<void>;
const lockListeners: LockListener[] = [];

/** Register a callback that runs after the wallet locks (auto-lock, popup lock, delete). */
export function addLockListener(fn: LockListener): void {
  lockListeners.push(fn);
}

// --- Session persistence (survives SW restarts, cleared on browser close) ---

const SESSION_KEY = 'aw_session';

async function saveSession(): Promise<void> {
  if (!vaultKeyRaw || !activeAccountId) return;
  lastActivity = Date.now();
  const data: SessionData = { vaultKey: vaultKeyRaw, activeAccountId, lastActivity };
  await chrome.storage.session.set({ [SESSION_KEY]: data });
}

async function loadSession(): Promise<SessionData | null> {
  const result = await chrome.storage.session.get(SESSION_KEY);
  const data = result[SESSION_KEY] as Partial<SessionData> & { masterPassword?: unknown } | undefined;
  if (!data) return null;
  if (typeof data.vaultKey !== 'string' || typeof data.activeAccountId !== 'string' || typeof data.lastActivity !== 'number') {
    // Pre-v2 sessions stored the master password. Never use (or keep) them;
    // the user unlocks once more.
    await clearSession();
    return null;
  }
  return data as SessionData;
}

async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}

/** Restore unlock state from session storage after SW restart. */
async function restoreFromSession(): Promise<boolean> {
  if (vaultKey && activeAccountId) return true; // already unlocked

  const session = await loadSession();
  if (!session) return false;

  // Check if auto-lock timeout has passed (pure decision)
  const autoLockMs = await getAutoLockMs();
  if (shouldAutoLock(session.lastActivity, autoLockMs)) {
    await clearSession();
    return false;
  }

  const vault = await getVault();
  const accounts = await getStoredAccounts();
  const target = resolveActiveAccount(accounts, session.activeAccountId);
  if (!vault || !target || target.id !== session.activeAccountId) {
    await clearSession();
    return false;
  }

  // Make sure the saved key still opens this wallet (it may have been deleted
  // and re-created since).
  const key = await importVaultKey(session.vaultKey);
  if (!(await keyOpensVault(key, vault))) {
    await clearSession();
    return false;
  }

  vaultKey = key;
  vaultKeyRaw = session.vaultKey;
  activeAccountId = session.activeAccountId;
  if (target.sealed && isPrivate(target)) {
    unlockedAccounts.set(target.id, await openAccount(target));
  }
  resetLockTimer();
  return true;
}

// --- Auto-lock ---

async function getAutoLockMs(): Promise<number> {
  const settings = await getItem<WalletSettings>(STORAGE_KEYS.SETTINGS);
  const minutes = settings?.autoLockMinutes ?? DEFAULT_SETTINGS.autoLockMinutes;
  return autoLockMsFromMinutes(minutes);
}

function resetLockTimer() {
  if (lockTimer) clearTimeout(lockTimer);
  saveSession();
  getAutoLockMs().then((ms) => {
    if (ms > 0) lockTimer = setTimeout(lock, ms);
  });
}

// --- Internal ---

async function getStoredAccounts(): Promise<StoredAccount[]> {
  return (await getItem<StoredAccount[]>(STORAGE_KEYS.ACCOUNTS)) ?? [];
}

async function saveStoredAccounts(accounts: StoredAccount[]): Promise<void> {
  await setItem(STORAGE_KEYS.ACCOUNTS, accounts);
}

async function getVault(): Promise<VaultRecord | null> {
  return getItem<VaultRecord>(STORAGE_KEYS.VAULT);
}

/** Accounts whose secret lives in this wallet (not Ledger, not watch-only). */
function isPrivate(stored: StoredAccount): boolean {
  return canSign(stored) && !isLedger(stored);
}

/**
 * Async variant for use across the message boundary. The MV3 service worker
 * can be terminated while the popup waits on long-running UI flows (e.g.
 * Ledger device prompts), wiping the in-memory key. When the SW wakes up to
 * handle the next message we have to rehydrate from session storage before
 * asserting unlocked state.
 */
async function ensureVaultKey(): Promise<CryptoKey> {
  if (!vaultKey) await restoreFromSession();
  if (!vaultKey) throw new Error('Wallet is locked');
  return vaultKey;
}

/** True for the "wrong key" failure of AES-GCM decryption; other errors are real failures. */
function isWrongKeyError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'OperationError';
}

async function keyOpensVault(key: CryptoKey, vault: VaultRecord): Promise<boolean> {
  try {
    return (await unseal(vault.verifier, key)) === PASSWORD_VERIFIER_PLAINTEXT;
  } catch (err) {
    if (isWrongKeyError(err)) return false;
    throw err;
  }
}

/** Derive the vault key from the password; throws 'Wrong password' if it doesn't open the vault. */
async function openVault(password: string, vault: VaultRecord): Promise<VaultKey> {
  const vk = await deriveVaultKey(password, vault.kdf);
  if (!(await keyOpensVault(vk.key, vault))) throw new Error('Wrong password');
  return vk;
}

async function createVaultRecord(password: string): Promise<{ vk: VaultKey; record: VaultRecord }> {
  const vk = await createVaultKey(password);
  const verifier = await seal(PASSWORD_VERIFIER_PLAINTEXT, vk.key);
  return { vk, record: { version: 2, kdf: vk.kdf, verifier } };
}

/** Decrypt a v1 blob, or null when this password doesn't open it. */
async function tryLegacyDecrypt(data: EncryptedData, password: string): Promise<string | null> {
  try {
    return await decrypt(data, password);
  } catch (err) {
    if (isWrongKeyError(err)) return null;
    throw err;
  }
}

async function openAccount(stored: StoredAccount): Promise<PrivateKeyAccount> {
  if (stored.sealed) {
    if (!vaultKey) throw new Error('Wallet is locked');
    return decryptToAccount(await unseal(stored.sealed, vaultKey));
  }
  if (stored.encrypted) {
    throw new Error(
      `"${stored.label}" was encrypted with a different password and can't be opened with this one. ` +
      'Export it with its original password (Settings → Export) and import it again.',
    );
  }
  throw new Error(`"${stored.label}" has no key material`);
}

/**
 * Re-seal every v1 account this password opens with the vault key. Each new
 * blob is opened again before it replaces the old one. Accounts the password
 * doesn't open (made under another password by an old bug) are left as-is.
 */
async function sealLegacyAccounts(
  accounts: StoredAccount[],
  password: string,
  key: CryptoKey,
): Promise<{ accounts: StoredAccount[]; changed: boolean }> {
  let changed = false;
  const out: StoredAccount[] = [];
  for (const a of accounts) {
    if (!a.encrypted || a.sealed || !isPrivate(a)) {
      out.push(a);
      continue;
    }
    const plaintext = await tryLegacyDecrypt(a.encrypted, password);
    if (plaintext === null) {
      console.warn(`[Auto-Wallet] Account ${a.id} does not open with the master password; leaving it in the old format`);
      out.push(a);
      continue;
    }
    const sealed = await seal(plaintext, key);
    if ((await unseal(sealed, key)) !== plaintext) {
      throw new Error(`Re-encrypting account ${a.id} failed verification; wallet left unchanged`);
    }
    const { encrypted: _old, ...rest } = a;
    out.push({ ...rest, sealed });
    changed = true;
  }
  return { accounts: out, changed };
}

/** Check a password against a v1 wallet (legacy verifier, else the first private account). */
async function verifyLegacyPassword(password: string, accounts: StoredAccount[]): Promise<void> {
  const verifier = await getItem<EncryptedData>(STORAGE_KEYS.PASSWORD_VERIFIER);
  if (verifier) {
    const plaintext = await tryLegacyDecrypt(verifier, password);
    if (plaintext !== PASSWORD_VERIFIER_PLAINTEXT) throw new Error('Wrong password');
    return;
  }
  const firstPrivate = accounts.find((a) => isPrivate(a) && a.encrypted);
  if (!firstPrivate?.encrypted) {
    throw new Error('No way to verify password — wallet has no verifier and no private accounts');
  }
  if ((await tryLegacyDecrypt(firstPrivate.encrypted, password)) === null) throw new Error('Wrong password');
}

/**
 * v1 → v2: verify the password the old way, build the vault, re-seal accounts,
 * then write accounts + vault in ONE storage call. If anything fails before
 * that write, the old data is untouched.
 */
async function migrateToVault(password: string, accounts: StoredAccount[]): Promise<{ vk: VaultKey; accounts: StoredAccount[] }> {
  await verifyLegacyPassword(password, accounts);
  const { vk, record } = await createVaultRecord(password);
  const migrated = await sealLegacyAccounts(accounts, password, vk.key);
  await setItems({
    [STORAGE_KEYS.ACCOUNTS]: migrated.accounts,
    [STORAGE_KEYS.VAULT]: record,
  });
  await removeItem(STORAGE_KEYS.PASSWORD_VERIFIER);
  return { vk, accounts: migrated.accounts };
}

function setUnlocked(vk: { key: CryptoKey; raw: string }): void {
  vaultKey = vk.key;
  vaultKeyRaw = vk.raw;
}

async function assertNoWallet(): Promise<void> {
  if (await hasWallet()) {
    throw new Error('A wallet already exists. Unlock it and use "Add account" instead.');
  }
}

/** First-time setup: new vault + first account(s), written together. */
async function createWalletWith(accounts: StoredAccount[], vk: VaultKey, record: VaultRecord): Promise<void> {
  const first = accounts[0]!;
  await setItems({
    [STORAGE_KEYS.ACCOUNTS]: accounts,
    [STORAGE_KEYS.VAULT]: record,
    [STORAGE_KEYS.ACTIVE_ACCOUNT_ID]: first.id,
  });
  setUnlocked(vk);
  unlockedAccounts.clear();
  activeAccountId = first.id;
  resetLockTimer();
}

async function createPrivateWallet(secret: string, password: string, label: string | undefined, source: AccountSource): Promise<string> {
  if (!password) throw new Error('Password is required');
  await assertNoWallet();
  const account = decryptToAccount(secret);
  const { vk, record } = await createVaultRecord(password);
  const stored: StoredAccount = {
    id: crypto.randomUUID(),
    label: label ?? nextAccountLabel(0),
    sealed: await seal(secret, vk.key),
    type: 'private',
    source,
    address: account.address,
    createdAt: Date.now(),
  };
  await createWalletWith([stored], vk, record);
  unlockedAccounts.set(stored.id, account);
  return account.address;
}

async function appendPrivateAndActivate(
  secret: string,
  account: PrivateKeyAccount,
  label: string,
  source: AccountSource,
): Promise<string> {
  const key = await ensureVaultKey();
  const sealed = await seal(secret, key);
  const id = crypto.randomUUID();
  const stored: StoredAccount = {
    id, label, sealed,
    type: 'private',
    source,
    address: account.address,
    createdAt: Date.now(),
  };
  const accounts = await getStoredAccounts();
  accounts.push(stored);
  await saveStoredAccounts(accounts);

  unlockedAccounts.set(id, account);
  activeAccountId = id;
  await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, id);
  resetLockTimer();
  return account.address;
}

async function getNextLabel(): Promise<string> {
  const accounts = await getStoredAccounts();
  return nextAccountLabel(accounts.length);
}

// --- Public API ---

export async function isUnlocked(): Promise<boolean> {
  if (activeAccountId !== null && vaultKey !== null) return true;
  return restoreFromSession();
}

/** Throws if active account is a Ledger account (caller must use a UI-context signer). */
export async function getAccount(): Promise<PrivateKeyAccount> {
  if (!activeAccountId || !vaultKey) {
    await restoreFromSession();
  }
  if (!activeAccountId || !vaultKey) throw new Error('Wallet is locked');

  // Lazy decrypt for the active account
  let account = unlockedAccounts.get(activeAccountId);
  if (!account) {
    const accounts = await getStoredAccounts();
    const target = accounts.find((a) => a.id === activeAccountId);
    if (!target) throw new Error('Active account not found');
    if (isWatchOnly(target)) {
      throw new Error('Active account is watch-only — it cannot sign transactions');
    }
    if (isLedger(target)) {
      throw new Error('Active account is a Ledger hardware wallet — signing must be performed in the UI');
    }
    account = await openAccount(target);
    unlockedAccounts.set(activeAccountId, account);
  }
  resetLockTimer();
  return account;
}

export async function getAddress(): Promise<string> {
  const info = await getActiveAccountInfo();
  return info.address;
}

export async function getActiveAccountId(): Promise<string> {
  if (!activeAccountId) await restoreFromSession();
  if (!activeAccountId) throw new Error('Wallet is locked');
  return activeAccountId;
}

export async function getActiveAccountInfo(): Promise<AccountInfo> {
  if (!activeAccountId) await restoreFromSession();
  if (!activeAccountId) throw new Error('Wallet is locked');
  const accounts = await getStoredAccounts();
  const stored = accounts.find((a) => a.id === activeAccountId);
  if (!stored) throw new Error('Active account not found');
  resetLockTimer();
  return toAccountInfo(stored);
}

export async function listAccounts(): Promise<AccountInfo[]> {
  const stored = await getStoredAccounts();
  return stored.map(toAccountInfo);
}

export async function switchAccount(accountId: string): Promise<string> {
  await ensureVaultKey();
  const stored = await getStoredAccounts();
  const target = stored.find((a) => a.id === accountId);
  if (!target) throw new Error('Account not found');

  if (isPrivate(target) && !unlockedAccounts.has(accountId)) {
    unlockedAccounts.set(accountId, await openAccount(target));
  }

  activeAccountId = accountId;
  await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, accountId);
  resetLockTimer();
  return target.address;
}

// ===== First-time setup (sets master password) =====

export async function createWallet(password: string, label?: string): Promise<string> {
  return createPrivateWallet(generatePrivateKey(), password, label, 'privateKey');
}

export async function importPrivateKey(privateKey: `0x${string}`, password: string, label?: string): Promise<string> {
  return createPrivateWallet(privateKey, password, label, 'privateKey');
}

export async function importMnemonic(mnemonic: string, password: string, label?: string): Promise<string> {
  return createPrivateWallet(mnemonic, password, label, 'mnemonic');
}

export interface LedgerAccountSeed {
  address: string;
  derivationPath: string;
  label?: string;
}

/**
 * First-time wallet setup using Ledger accounts only. The user still chooses a
 * master password (used for the vault verifier and to seal any future
 * private-key accounts). At least one ledger account must be supplied.
 */
export async function setupLedgerWallet(password: string, seeds: LedgerAccountSeed[]): Promise<string> {
  if (seeds.length === 0) throw new Error('Pick at least one Ledger address');
  if (!password) throw new Error('Password is required');
  await assertNoWallet();

  const accounts: StoredAccount[] = seeds.map((seed, idx) => ({
    id: crypto.randomUUID(),
    label: seed.label?.trim() || nextAccountLabel(idx),
    type: 'ledger',
    address: seed.address,
    derivationPath: seed.derivationPath,
    createdAt: Date.now(),
  }));

  const { vk, record } = await createVaultRecord(password);
  await createWalletWith(accounts, vk, record);
  return accounts[0]!.address;
}

// ===== Add account (reuses the unlocked vault key) =====

export async function addAccountGenerate(label?: string): Promise<string> {
  const privateKey = generatePrivateKey();
  const account = decryptToAccount(privateKey);
  return appendPrivateAndActivate(privateKey, account, label ?? await getNextLabel(), 'privateKey');
}

export async function addAccountPrivateKey(privateKey: `0x${string}`, label?: string): Promise<string> {
  const account = decryptToAccount(privateKey);
  return appendPrivateAndActivate(privateKey, account, label ?? await getNextLabel(), 'privateKey');
}

export async function addAccountMnemonic(mnemonic: string, label?: string): Promise<string> {
  const account = decryptToAccount(mnemonic);
  return appendPrivateAndActivate(mnemonic, account, label ?? await getNextLabel(), 'mnemonic');
}

/** Append one or more Ledger accounts to an existing wallet. Returns the address of the first added account. */
export async function addLedgerAccounts(seeds: LedgerAccountSeed[]): Promise<string> {
  if (seeds.length === 0) throw new Error('Pick at least one Ledger address');
  await ensureVaultKey(); // rehydrate session if SW restarted during the Ledger flow

  const accounts = await getStoredAccounts();
  const existingAddrs = new Set(accounts.map((a) => a.address.toLowerCase()));
  let addedFirst: StoredAccount | null = null;
  for (const seed of seeds) {
    if (existingAddrs.has(seed.address.toLowerCase())) continue;
    const id = crypto.randomUUID();
    const stored: StoredAccount = {
      id,
      label: seed.label?.trim() || nextAccountLabel(accounts.length),
      type: 'ledger',
      address: seed.address,
      derivationPath: seed.derivationPath,
      createdAt: Date.now(),
    };
    accounts.push(stored);
    if (!addedFirst) addedFirst = stored;
  }
  await saveStoredAccounts(accounts);

  if (addedFirst) {
    activeAccountId = addedFirst.id;
    await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, addedFirst.id);
    resetLockTimer();
    return addedFirst.address;
  }
  // All seeds were duplicates — keep current active.
  return (await getActiveAccountInfo()).address;
}

// ===== Unlock / Lock =====

export async function unlock(password: string): Promise<string> {
  if (!password) throw new Error('Password is required');
  let accounts = await getStoredAccounts();

  // Oldest format: a single encrypted key, no accounts list yet.
  const legacyKey = await getItem<EncryptedData>(STORAGE_KEYS.ENCRYPTED_KEY);
  if (accounts.length === 0) {
    if (!legacyKey) throw new Error('No wallet found. Please create or import one.');
    const plaintext = await tryLegacyDecrypt(legacyKey, password);
    if (plaintext === null) throw new Error('Wrong password');
    const account = decryptToAccount(plaintext);
    accounts = [{
      id: crypto.randomUUID(), label: 'Account 1', encrypted: legacyKey,
      type: 'private',
      source: plaintext.startsWith('0x') ? 'privateKey' : 'mnemonic',
      address: account.address, createdAt: Date.now(),
    }];
  }

  let vk: VaultKey;
  const vault = await getVault();
  if (vault) {
    vk = await openVault(password, vault);
    // Leftovers in the old format (e.g. a migration interrupted before v2
    // existed) are picked up whenever the password opens them.
    const resealed = await sealLegacyAccounts(accounts, password, vk.key);
    if (resealed.changed) {
      accounts = resealed.accounts;
      await saveStoredAccounts(accounts);
    }
  } else {
    ({ vk, accounts } = await migrateToVault(password, accounts));
  }
  // Old-format leftovers are safe to drop once the vault is written.
  if (legacyKey) await removeItem(STORAGE_KEYS.ENCRYPTED_KEY);
  if (vault && (await getItem(STORAGE_KEYS.PASSWORD_VERIFIER))) await removeItem(STORAGE_KEYS.PASSWORD_VERIFIER);

  return finishUnlock(vk, accounts);
}

/** Shared tail of password and biometric unlock: load the active account and start the session. */
async function finishUnlock(vk: { key: CryptoKey; raw: string }, accounts: StoredAccount[]): Promise<string> {
  const savedActiveId = await getItem<string>(STORAGE_KEYS.ACTIVE_ACCOUNT_ID);
  const targetAccount = resolveActiveAccount(accounts, savedActiveId) ?? accounts[0]!;

  setUnlocked(vk);
  unlockedAccounts.clear();
  if (isPrivate(targetAccount) && targetAccount.sealed) {
    unlockedAccounts.set(targetAccount.id, await openAccount(targetAccount));
  }
  activeAccountId = targetAccount.id;
  await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, targetAccount.id);
  resetLockTimer();

  // Best-effort migration of the legacy Address Book into watch-only accounts.
  // Idempotent — the storage key is removed after the first successful run.
  await migrateAddressBookToWatchOnlyOnce();

  return targetAccount.address;
}

// ===== Biometric unlock (Touch ID / Windows Hello via WebAuthn PRF) =====
//
// The WebAuthn calls run in the extension page (the service worker has no
// navigator.credentials); the page passes the PRF secret here as base64.

export async function getBiometricStatus(): Promise<BiometricStatus> {
  const record = await getItem<BiometricRecord>(STORAGE_KEYS.BIOMETRIC);
  if (!record) return { enabled: false };
  return { enabled: true, credentialId: record.credentialId, prfSalt: record.prfSalt };
}

export async function enableBiometric(
  password: string,
  cred: { credentialId: string; prfSalt: string; prfOutput: string },
): Promise<void> {
  const vault = await getVault();
  if (!vault) throw new Error('Unlock once with your password before turning on Touch ID');
  const vk = await openVault(password, vault);
  const wrapKey = await biometricWrapKey(cred.prfOutput);
  const record: BiometricRecord = {
    version: 1,
    credentialId: cred.credentialId,
    prfSalt: cred.prfSalt,
    sealedVaultKey: await seal(vk.raw, wrapKey),
    createdAt: Date.now(),
  };
  await setItem(STORAGE_KEYS.BIOMETRIC, record);
}

/** Check the password against the vault; throws 'Wrong password'. Used before the Touch ID prompt. */
export async function verifyPassword(password: string): Promise<true> {
  const vault = await getVault();
  if (!vault) throw new Error('Unlock once with your password before turning on Touch ID');
  await openVault(password, vault);
  return true;
}

export async function disableBiometric(): Promise<void> {
  await removeItem(STORAGE_KEYS.BIOMETRIC);
}

export async function unlockWithBiometric(prfOutput: string): Promise<string> {
  const record = await getItem<BiometricRecord>(STORAGE_KEYS.BIOMETRIC);
  if (!record) throw new Error('Touch ID unlock is not enabled');
  const vault = await getVault();
  if (!vault) throw new Error('No wallet vault found');

  const wrapKey = await biometricWrapKey(prfOutput);
  let raw: string;
  try {
    raw = await unseal(record.sealedVaultKey, wrapKey);
  } catch (err) {
    if (isWrongKeyError(err)) throw new Error('Touch ID key does not match. Unlock with your password.');
    throw err;
  }
  const key = await importVaultKey(raw);
  // The password may have changed since Touch ID was set up.
  if (!(await keyOpensVault(key, vault))) {
    throw new Error('Touch ID key is out of date. Unlock with your password and turn Touch ID on again.');
  }
  return finishUnlock({ key, raw }, await getStoredAccounts());
}

export async function lock(): Promise<void> {
  unlockedAccounts.clear();
  activeAccountId = null;
  vaultKey = null;
  vaultKeyRaw = null;
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  await clearSession();
  for (const fn of [...lockListeners]) {
    await fn();
  }
}

/** Test-only: drop in-memory state but keep the session, as a worker restart does. */
export function forgetInMemoryStateForTests(): void {
  unlockedAccounts.clear();
  activeAccountId = null;
  vaultKey = null;
  vaultKeyRaw = null;
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
}

export async function hasWallet(): Promise<boolean> {
  const accounts = await getStoredAccounts();
  if (accounts.length > 0) return true;
  const legacy = await getItem<EncryptedData>(STORAGE_KEYS.ENCRYPTED_KEY);
  return legacy !== null;
}

export async function renameAccount(accountId: string, newLabel: string): Promise<void> {
  const accounts = await getStoredAccounts();
  const idx = accounts.findIndex((a) => a.id === accountId);
  if (idx < 0) throw new Error('Account not found');
  const account = accounts[idx];
  if (!account) throw new Error('Account not found');
  account.label = newLabel;
  await saveStoredAccounts(accounts);
}

export async function removeAccount(accountId: string): Promise<void> {
  const accounts = await getStoredAccounts();
  if (accounts.length <= 1) throw new Error('Cannot remove the last account');
  const filtered = accounts.filter((a) => a.id !== accountId);
  await saveStoredAccounts(filtered);
  unlockedAccounts.delete(accountId);

  if (activeAccountId === accountId) {
    const nextActive = filtered[0];
    if (!nextActive) throw new Error('No account available after removal');
    activeAccountId = nextActive.id;
    await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, activeAccountId);
    // Opened lazily by getAccount() when it is next needed.
    await saveSession();
  }
}

export async function deleteWallet(): Promise<void> {
  await lock();
  await removeItem(STORAGE_KEYS.ACCOUNTS);
  await removeItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID);
  await removeItem(STORAGE_KEYS.ENCRYPTED_KEY);
  await removeItem(STORAGE_KEYS.PASSWORD_VERIFIER);
  await removeItem(STORAGE_KEYS.VAULT);
  await removeItem(STORAGE_KEYS.BIOMETRIC);
}

export async function exportPrivateKey(accountId: string, password: string): Promise<string> {
  const accounts = await getStoredAccounts();
  const target = accounts.find((a) => a.id === accountId);
  if (!target) throw new Error('Account not found');
  if (isWatchOnly(target)) {
    throw new Error('Cannot export — this account is watch-only and has no private key');
  }
  if (isLedger(target)) {
    throw new Error('Cannot export — this account is a Ledger hardware wallet');
  }
  if (target.sealed) {
    const vault = await getVault();
    if (!vault) throw new Error('Wallet data is inconsistent: sealed account without a vault');
    const vk = await openVault(password, vault);
    return unseal(target.sealed, vk.key);
  }
  if (target.encrypted) {
    // Not migrated yet, or made under another password: its own password opens it.
    return decrypt(target.encrypted, password);
  }
  throw new Error('Cannot export — this account has no key material');
}

// ===== Watch-only accounts (Rabby-style) =====

/**
 * Add a public address as a watch-only account. Requires the wallet to be set
 * up (so we have somewhere to place the account in the active accounts list),
 * but does NOT require the master password since no key material is stored.
 */
export async function addWatchOnlyAccount(address: string, label?: string): Promise<string> {
  if (!isAddress(address)) throw new Error('Invalid address');
  const checksummed = toChecksumAddress(address);

  const accounts = await getStoredAccounts();
  // Disallow duplicates regardless of source — a single address should never
  // appear twice in the account list.
  if (accounts.some((a) => a.address.toLowerCase() === checksummed.toLowerCase())) {
    throw new Error('This address is already in your accounts');
  }

  const stored: StoredAccount = {
    id: crypto.randomUUID(),
    label: label?.trim() || nextAccountLabel(accounts.length),
    type: 'watchOnly',
    source: 'watchOnly',
    address: checksummed,
    createdAt: Date.now(),
  };
  accounts.push(stored);
  await saveStoredAccounts(accounts);

  // Switch to the new watch-only account so the user can see what they just
  // added (mirrors how addAccountGenerate / addAccountPrivateKey behave).
  activeAccountId = stored.id;
  await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, stored.id);
  resetLockTimer();
  return checksummed;
}

// ===== Address Book → Watch-Only migration =====

interface LegacyAddressBookEntry {
  id?: string;
  name?: string;
  address?: string;
  createdAt?: number;
}

const LEGACY_ADDRESS_BOOK_KEY = 'address_book';

/**
 * One-time migration: previous versions stored a separate "Address Book". Each
 * entry becomes a watch-only account so the user keeps all their saved
 * addresses, now usable as accounts they can switch to in read-only mode.
 *
 * Idempotent: the storage key is removed at the end. Safe to call repeatedly.
 * Only runs when there's already at least one real account, so we don't
 * interfere with the legacy single-key unlock path.
 */
export async function migrateAddressBookToWatchOnlyOnce(): Promise<void> {
  const entries = await getItem<LegacyAddressBookEntry[]>(LEGACY_ADDRESS_BOOK_KEY);
  if (!entries || entries.length === 0) {
    if (entries !== null) await removeItem(LEGACY_ADDRESS_BOOK_KEY);
    return;
  }

  const accounts = await getStoredAccounts();
  if (accounts.length === 0) {
    // Wait for the user to finish first-time setup before we touch their data.
    return;
  }

  const existing = new Set(accounts.map((a) => a.address.toLowerCase()));
  let nextLabelIdx = accounts.length;
  for (const entry of entries) {
    if (!entry?.address || !isAddress(entry.address)) continue;
    const checksummed = toChecksumAddress(entry.address);
    if (existing.has(checksummed.toLowerCase())) continue;
    const label = entry.name?.trim() || nextAccountLabel(nextLabelIdx);
    accounts.push({
      id: crypto.randomUUID(),
      label,
      type: 'watchOnly',
      source: 'watchOnly',
      address: checksummed,
      createdAt: entry.createdAt ?? Date.now(),
    });
    existing.add(checksummed.toLowerCase());
    nextLabelIdx++;
  }

  await saveStoredAccounts(accounts);
  await removeItem(LEGACY_ADDRESS_BOOK_KEY);
}
