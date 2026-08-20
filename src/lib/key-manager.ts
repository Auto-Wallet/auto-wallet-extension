// IO shell: chrome.storage + session management.
// Pure decision logic lives in key-manager.core.ts.

import { generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts';
import { encrypt, decrypt, type EncryptedData } from './crypto';
import { getItem, setItem, removeItem, STORAGE_KEYS } from './storage';
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
} from './key-manager.core';

// Re-export types for backward compatibility
export type { StoredAccount, AccountInfo } from './key-manager.core';

// --- In-memory state (rebuilt from session storage on SW wake) ---
// Only private accounts hold a viem account in memory; ledger accounts are
// metadata-only at the background layer (signing happens in UI contexts).
let unlockedAccounts: Map<string, PrivateKeyAccount> = new Map();
let activeAccountId: string | null = null;
let masterPassword: string | null = null;
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
  if (!masterPassword || !activeAccountId) return;
  lastActivity = Date.now();
  const data: SessionData = { masterPassword, activeAccountId, lastActivity };
  await chrome.storage.session.set({ [SESSION_KEY]: data });
}

async function loadSession(): Promise<SessionData | null> {
  const result = await chrome.storage.session.get(SESSION_KEY);
  return (result[SESSION_KEY] as SessionData) ?? null;
}

async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}

/** Restore unlock state from session storage after SW restart. */
async function restoreFromSession(): Promise<boolean> {
  if (masterPassword && activeAccountId) return true; // already unlocked

  const session = await loadSession();
  if (!session) return false;

  // Check if auto-lock timeout has passed (pure decision)
  const autoLockMs = await getAutoLockMs();
  if (shouldAutoLock(session.lastActivity, autoLockMs)) {
    await clearSession();
    return false;
  }

  const accounts = await getStoredAccounts();
  const target = resolveActiveAccount(accounts, session.activeAccountId);
  if (!target || target.id !== session.activeAccountId) {
    await clearSession();
    return false;
  }

  // Verify the saved password is still valid by decrypting the verifier
  // (or, for legacy wallets, the first private account).
  try {
    await verifyPassword(session.masterPassword, accounts);
  } catch {
    await clearSession();
    return false;
  }

  masterPassword = session.masterPassword;
  activeAccountId = session.activeAccountId;
  if (canSign(target) && !isLedger(target) && target.encrypted) {
    const plaintext = await decrypt(target.encrypted, session.masterPassword);
    unlockedAccounts.set(target.id, decryptToAccount(plaintext));
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

function getMasterPassword(): string {
  if (!masterPassword) throw new Error('Wallet is locked');
  return masterPassword;
}

/**
 * Async variant for use across the message boundary. The MV3 service worker
 * can be terminated while the popup waits on long-running UI flows (e.g.
 * Ledger device prompts), wiping the in-memory `masterPassword`. When the SW
 * wakes up to handle the next message we have to rehydrate from session
 * storage before asserting unlocked state.
 */
async function ensureMasterPassword(): Promise<string> {
  if (!masterPassword) await restoreFromSession();
  if (!masterPassword) throw new Error('Wallet is locked');
  return masterPassword;
}

async function getPasswordVerifier(): Promise<EncryptedData | null> {
  return getItem<EncryptedData>(STORAGE_KEYS.PASSWORD_VERIFIER);
}

async function ensurePasswordVerifier(password: string): Promise<void> {
  const existing = await getPasswordVerifier();
  if (existing) return;
  const encrypted = await encrypt(PASSWORD_VERIFIER_PLAINTEXT, password);
  await setItem(STORAGE_KEYS.PASSWORD_VERIFIER, encrypted);
}

/** Verify password against the verifier blob (or the first private account for legacy wallets). */
async function verifyPassword(password: string, accounts: StoredAccount[]): Promise<void> {
  const verifier = await getPasswordVerifier();
  if (verifier) {
    const plaintext = await decrypt(verifier, password);
    if (plaintext !== PASSWORD_VERIFIER_PLAINTEXT) throw new Error('Wrong password');
    return;
  }
  // Legacy wallets: verify by decrypting the first private account, then backfill the verifier.
  const firstPrivate = accounts.find((a) => canSign(a) && !isLedger(a) && a.encrypted);
  if (!firstPrivate || !firstPrivate.encrypted) {
    throw new Error('No way to verify password — wallet has no verifier and no private accounts');
  }
  await decrypt(firstPrivate.encrypted, password); // throws on wrong password
  await ensurePasswordVerifier(password);
}

async function appendPrivateAndActivate(
  secret: string,
  account: PrivateKeyAccount,
  label: string,
  pw: string,
  source: AccountSource,
): Promise<string> {
  const encrypted = await encrypt(secret, pw);
  const id = crypto.randomUUID();
  const stored: StoredAccount = {
    id, label, encrypted,
    type: 'private',
    source,
    address: account.address,
    createdAt: Date.now(),
  };
  const accounts = await getStoredAccounts();
  accounts.push(stored);
  await saveStoredAccounts(accounts);

  masterPassword = pw;
  await ensurePasswordVerifier(pw);
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
  if (activeAccountId !== null && masterPassword !== null) return true;
  return restoreFromSession();
}

/** Throws if active account is a Ledger account (caller must use a UI-context signer). */
export async function getAccount(): Promise<PrivateKeyAccount> {
  if (!activeAccountId || !masterPassword) {
    await restoreFromSession();
  }
  if (!activeAccountId || !masterPassword) throw new Error('Wallet is locked');

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
    if (!target.encrypted) throw new Error('Active account is missing encrypted key');
    const plaintext = await decrypt(target.encrypted, masterPassword);
    account = decryptToAccount(plaintext);
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
  const pw = await ensureMasterPassword();
  const stored = await getStoredAccounts();
  const target = stored.find((a) => a.id === accountId);
  if (!target) throw new Error('Account not found');

  if (canSign(target) && !isLedger(target) && target.encrypted && !unlockedAccounts.has(accountId)) {
    const plaintext = await decrypt(target.encrypted, pw);
    unlockedAccounts.set(accountId, decryptToAccount(plaintext));
  }

  activeAccountId = accountId;
  await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, accountId);
  resetLockTimer();
  return target.address;
}

// ===== First-time setup (sets master password) =====

export async function createWallet(password: string, label?: string): Promise<string> {
  const privateKey = generatePrivateKey();
  const account = decryptToAccount(privateKey);
  return appendPrivateAndActivate(privateKey, account, label ?? await getNextLabel(), password, 'privateKey');
}

export async function importPrivateKey(privateKey: `0x${string}`, password: string, label?: string): Promise<string> {
  const account = decryptToAccount(privateKey);
  return appendPrivateAndActivate(privateKey, account, label ?? await getNextLabel(), password, 'privateKey');
}

export async function importMnemonic(mnemonic: string, password: string, label?: string): Promise<string> {
  const account = decryptToAccount(mnemonic);
  return appendPrivateAndActivate(mnemonic, account, label ?? await getNextLabel(), password, 'mnemonic');
}

export interface LedgerAccountSeed {
  address: string;
  derivationPath: string;
  label?: string;
}

/**
 * First-time wallet setup using Ledger accounts only. The user still chooses a
 * master password (used for the password verifier and to encrypt any future
 * private-key accounts). At least one ledger account must be supplied.
 */
export async function setupLedgerWallet(password: string, seeds: LedgerAccountSeed[]): Promise<string> {
  if (seeds.length === 0) throw new Error('Pick at least one Ledger address');

  const accounts: StoredAccount[] = [];
  let baseLabelIdx = 0;
  for (const seed of seeds) {
    const id = crypto.randomUUID();
    accounts.push({
      id,
      label: seed.label?.trim() || nextAccountLabel(baseLabelIdx),
      type: 'ledger',
      address: seed.address,
      derivationPath: seed.derivationPath,
      createdAt: Date.now(),
    });
    baseLabelIdx++;
  }

  await saveStoredAccounts(accounts);
  await setItem(STORAGE_KEYS.PASSWORD_VERIFIER, await encrypt(PASSWORD_VERIFIER_PLAINTEXT, password));

  const first = accounts[0]!;
  masterPassword = password;
  activeAccountId = first.id;
  await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, first.id);
  resetLockTimer();
  return first.address;
}

// ===== Add account (reuses master password) =====

export async function addAccountGenerate(label?: string): Promise<string> {
  const pw = await ensureMasterPassword();
  const privateKey = generatePrivateKey();
  const account = decryptToAccount(privateKey);
  return appendPrivateAndActivate(privateKey, account, label ?? await getNextLabel(), pw, 'privateKey');
}

export async function addAccountPrivateKey(privateKey: `0x${string}`, label?: string): Promise<string> {
  const pw = await ensureMasterPassword();
  const account = decryptToAccount(privateKey);
  return appendPrivateAndActivate(privateKey, account, label ?? await getNextLabel(), pw, 'privateKey');
}

export async function addAccountMnemonic(mnemonic: string, label?: string): Promise<string> {
  const pw = await ensureMasterPassword();
  const account = decryptToAccount(mnemonic);
  return appendPrivateAndActivate(mnemonic, account, label ?? await getNextLabel(), pw, 'mnemonic');
}

/** Append one or more Ledger accounts to an existing wallet. Returns the address of the first added account. */
export async function addLedgerAccounts(seeds: LedgerAccountSeed[]): Promise<string> {
  if (seeds.length === 0) throw new Error('Pick at least one Ledger address');
  await ensureMasterPassword(); // rehydrate session if SW restarted during the Ledger flow

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
  if (accounts.length === 0) {
    const legacy = await getItem<EncryptedData>(STORAGE_KEYS.ENCRYPTED_KEY);
    if (!legacy) throw new Error('No wallet found. Please create or import one.');
    const plaintext = await decrypt(legacy, password);
    const account = decryptToAccount(plaintext);
    const id = crypto.randomUUID();
    const stored: StoredAccount = {
      id, label: 'Account 1', encrypted: legacy,
      type: 'private',
      source: plaintext.startsWith('0x') ? 'privateKey' : 'mnemonic',
      address: account.address, createdAt: Date.now(),
    };
    await saveStoredAccounts([stored]);
    await removeItem(STORAGE_KEYS.ENCRYPTED_KEY);
    masterPassword = password;
    await ensurePasswordVerifier(password);
    unlockedAccounts.set(id, account);
    activeAccountId = id;
    await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, id);
    resetLockTimer();
    return account.address;
  }

  // Validate password (and backfill the verifier for legacy wallets).
  await verifyPassword(password, accounts);

  const savedActiveId = await getItem<string>(STORAGE_KEYS.ACTIVE_ACCOUNT_ID);
  const targetAccount = resolveActiveAccount(accounts, savedActiveId) ?? accounts[0]!;

  masterPassword = password;
  unlockedAccounts.clear();
  if (canSign(targetAccount) && !isLedger(targetAccount) && targetAccount.encrypted) {
    const plaintext = await decrypt(targetAccount.encrypted, password);
    unlockedAccounts.set(targetAccount.id, decryptToAccount(plaintext));
  }
  activeAccountId = targetAccount.id;
  await setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, targetAccount.id);
  resetLockTimer();

  // Best-effort migration of the legacy Address Book into watch-only accounts.
  // Idempotent — the storage key is removed after the first successful run.
  await migrateAddressBookToWatchOnlyOnce();

  return targetAccount.address;
}

export async function lock(): Promise<void> {
  unlockedAccounts.clear();
  activeAccountId = null;
  masterPassword = null;
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  await clearSession();
  for (const fn of [...lockListeners]) {
    await fn();
  }
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
    if (masterPassword && canSign(nextActive) && !isLedger(nextActive) && nextActive.encrypted) {
      const plaintext = await decrypt(nextActive.encrypted, masterPassword);
      unlockedAccounts.set(nextActive.id, decryptToAccount(plaintext));
    }
    await saveSession();
  }
}

export async function deleteWallet(): Promise<void> {
  await lock();
  await removeItem(STORAGE_KEYS.ACCOUNTS);
  await removeItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID);
  await removeItem(STORAGE_KEYS.ENCRYPTED_KEY);
  await removeItem(STORAGE_KEYS.PASSWORD_VERIFIER);
}

export async function exportPrivateKey(accountId: string, password: string): Promise<string> {
  const accounts = await getStoredAccounts();
  const target = accounts.find((a) => a.id === accountId);
  if (!target) throw new Error('Account not found');
  if (isWatchOnly(target)) {
    throw new Error('Cannot export — this account is watch-only and has no private key');
  }
  if (isLedger(target) || !target.encrypted) {
    throw new Error('Cannot export — this account is a Ledger hardware wallet');
  }
  return decrypt(target.encrypted, password);
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
