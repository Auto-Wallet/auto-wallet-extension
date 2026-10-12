// Pure decision functions for key/account management.
// Zero IO, zero chrome dependency — fully testable.

import { privateKeyToAccount, mnemonicToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { EncryptedData, SealedData, VaultKdf } from './crypto';

// --- Types (shared with key-manager.ts IO layer) ---

export type AccountType = 'private' | 'ledger' | 'watchOnly';
export type AccountSource = 'privateKey' | 'mnemonic' | 'ledger' | 'watchOnly';

export interface StoredAccount {
  id: string;
  label: string;
  address: string;
  createdAt: number;
  // Optional fields — undefined `type` means legacy 'private'.
  type?: AccountType;
  source?: AccountSource;
  // Private accounts hold their secret in exactly one of these:
  sealed?: SealedData;       // v2: sealed with the vault key
  encrypted?: EncryptedData; // v1 (legacy): own salt, keyed by the password
  derivationPath?: string;   // present for type === 'ledger'
}

/** v2 vault: how to re-derive the key, plus a blob that proves the password. */
export interface VaultRecord {
  version: 2;
  kdf: VaultKdf;
  verifier: SealedData;
}

/**
 * Touch ID / Windows Hello unlock. The vault key is sealed with a key derived
 * from the WebAuthn PRF secret of `credentialId` evaluated on `prfSalt`.
 * The credential id and salt are not secret; the PRF secret never leaves the
 * authenticator until the user passes the fingerprint check.
 */
export interface BiometricRecord {
  version: 1;
  credentialId: string; // base64url, as WebAuthn gives it
  prfSalt: string;      // base64
  sealedVaultKey: SealedData;
  createdAt: number;
}

export type BiometricStatus =
  | { enabled: false }
  | { enabled: true; credentialId: string; prfSalt: string };

export interface AccountInfo {
  id: string;
  label: string;
  address: string;
  type: AccountType;
  source: AccountSource;
  derivationPath?: string;
}

/** Kept in chrome.storage.session: the derived key bytes, never the password. */
export interface SessionData {
  vaultKey: string; // base64 raw AES key
  activeAccountId: string;
  lastActivity: number;
}

// Plaintext encrypted into the password verifier blob. The actual value doesn't
// matter — we only check that decryption succeeds with the given password.
export const PASSWORD_VERIFIER_PLAINTEXT = 'auto-wallet-verifier-v1';

// --- Pure functions ---

/** Default account type for stored accounts that predate the `type` field. */
export function accountType(stored: StoredAccount): AccountType {
  return stored.type ?? 'private';
}

export function accountSource(stored: StoredAccount): AccountSource {
  const t = accountType(stored);
  if (t === 'ledger') return 'ledger';
  if (t === 'watchOnly') return 'watchOnly';
  return stored.source ?? 'privateKey';
}

export function isLedger(stored: StoredAccount): boolean {
  return accountType(stored) === 'ledger';
}

export function isWatchOnly(stored: StoredAccount): boolean {
  return accountType(stored) === 'watchOnly';
}

/** Watch-only accounts hold no signing material and can never produce signatures. */
export function canSign(stored: StoredAccount): boolean {
  return !isWatchOnly(stored);
}

/**
 * Order accounts for display: signing accounts in their original order first,
 * watch-only accounts grouped at the bottom (preserving relative order).
 */
export function partitionAccountsForDisplay<T extends { type?: AccountType }>(
  accounts: T[],
): { signers: T[]; watchOnly: T[] } {
  const signers: T[] = [];
  const watchOnly: T[] = [];
  for (const a of accounts) {
    if (a.type === 'watchOnly') watchOnly.push(a);
    else signers.push(a);
  }
  return { signers, watchOnly };
}

/**
 * Convert a decrypted plaintext (private key or mnemonic) into a viem account.
 * Private keys start with "0x"; everything else is treated as a mnemonic.
 */
export function decryptToAccount(plaintext: string): PrivateKeyAccount {
  if (plaintext.startsWith('0x')) {
    return privateKeyToAccount(plaintext as `0x${string}`);
  }
  return mnemonicToAccount(plaintext) as unknown as PrivateKeyAccount;
}

/**
 * Determine whether the auto-lock timeout has elapsed.
 * Returns true if the wallet should be locked.
 */
export function shouldAutoLock(lastActivity: number, autoLockMs: number, now: number = Date.now()): boolean {
  if (autoLockMs <= 0) return false; // 0 = never lock
  return (now - lastActivity) >= autoLockMs;
}

/** Convert auto-lock setting (minutes) to milliseconds. 0 = never lock. */
export function autoLockMsFromMinutes(minutes: number): number {
  if (minutes === 0) return 0;
  return minutes * 60 * 1000;
}

/**
 * Pick the active account from a stored accounts list.
 * Falls back to the first account if the saved ID is not found.
 */
export function resolveActiveAccount(
  accounts: StoredAccount[],
  savedActiveId: string | null,
): StoredAccount | undefined {
  if (accounts.length === 0) return undefined;
  if (savedActiveId) {
    const found = accounts.find((a) => a.id === savedActiveId);
    if (found) return found;
  }
  return accounts[0];
}

/** Generate the next default label based on how many accounts exist. */
export function nextAccountLabel(existingCount: number): string {
  return `Account ${existingCount + 1}`;
}

/** Extract public AccountInfo from a StoredAccount. */
export function toAccountInfo(stored: StoredAccount): AccountInfo {
  return {
    id: stored.id,
    label: stored.label,
    address: stored.address,
    type: accountType(stored),
    source: accountSource(stored),
    derivationPath: stored.derivationPath,
  };
}
