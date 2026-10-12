// AES-256-GCM encryption for private key storage

const ALGO = 'AES-GCM' as const;
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const ITERATIONS = 600_000; // PBKDF2 iterations

export interface EncryptedData {
  ciphertext: string; // base64
  iv: string;         // base64
  salt: string;       // base64
}

async function deriveKey(password: string, salt: BufferSource): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

function toBase64(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer
    ? new Uint8Array(buf)
    : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encrypt(plaintext: string, password: string): Promise<EncryptedData> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    salt: toBase64(salt),
  };
}

export async function decrypt(data: EncryptedData, password: string): Promise<string> {
  const salt = fromBase64(data.salt);
  const iv = fromBase64(data.iv);
  const ciphertext = fromBase64(data.ciphertext);
  const key = await deriveKey(password, salt);
  const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// --- Vault key (v2) ---
//
// One AES-GCM key is derived from the password (PBKDF2, own salt) and seals
// every account. The session keeps only these key bytes, never the password,
// so the user's password (often reused elsewhere) is not stored anywhere.

export interface VaultKdf {
  name: 'PBKDF2-SHA256';
  salt: string;       // base64
  iterations: number;
}

export interface SealedData {
  ciphertext: string; // base64
  iv: string;         // base64
}

export interface VaultKey {
  key: CryptoKey;
  raw: string;        // base64 key bytes, kept in chrome.storage.session
  kdf: VaultKdf;
}

async function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: ALGO }, false, ['encrypt', 'decrypt']);
}

export async function deriveVaultKey(password: string, kdf: VaultKdf): Promise<VaultKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64(kdf.salt), iterations: kdf.iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH,
  );
  const raw = new Uint8Array(bits);
  return { key: await importAesKey(raw), raw: toBase64(raw), kdf };
}

/** New vault: fresh salt, current iteration count. */
export async function createVaultKey(password: string): Promise<VaultKey> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  return deriveVaultKey(password, { name: 'PBKDF2-SHA256', salt: toBase64(salt), iterations: ITERATIONS });
}

/** Rebuild the key from the bytes saved in session storage. */
export async function importVaultKey(raw: string): Promise<CryptoKey> {
  return importAesKey(fromBase64(raw));
}

export async function seal(plaintext: string, key: CryptoKey): Promise<SealedData> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

export async function unseal(data: SealedData, key: CryptoKey): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGO, iv: fromBase64(data.iv) },
    key,
    fromBase64(data.ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

// --- Biometric wrap key ---
//
// A WebAuthn PRF result (32 secret bytes the authenticator only releases after
// Touch ID / Windows Hello) is stretched with HKDF into an AES key. That key
// seals a second copy of the vault key, so a fingerprint can stand in for the
// password without the vault key ever sitting on disk in the clear.

const PRF_OUTPUT_LENGTH = 32;
const BIOMETRIC_HKDF_INFO = 'auto-wallet biometric wrap v1';

export async function biometricWrapKey(prfOutputB64: string): Promise<CryptoKey> {
  const prf = fromBase64(prfOutputB64);
  if (prf.length !== PRF_OUTPUT_LENGTH) {
    throw new Error(`PRF output must be ${PRF_OUTPUT_LENGTH} bytes, got ${prf.length}`);
  }
  const material = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(BIOMETRIC_HKDF_INFO) },
    material,
    { name: ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
