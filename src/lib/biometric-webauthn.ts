// Page-side WebAuthn for Touch ID / Windows Hello unlock.
//
// Runs in extension pages only (popup, unlock window): the MV3 service worker
// has no navigator.credentials. We use the PRF extension, which makes the
// authenticator return 32 secret bytes for (credential, salt) only after the
// fingerprint check passes. The background turns those bytes into the key that
// seals a copy of the vault key (see enableBiometric in key-manager.ts).
//
// There is no server, so the challenge is never verified; the security comes
// from the PRF secret itself, not from the signature.

const SALT_LENGTH = 32;
const UNSUPPORTED = 'This device does not support Touch ID unlock for extensions (WebAuthn PRF).';

export interface BiometricRegistration {
  credentialId: string; // base64url
  prfSalt: string;      // base64
  prfOutput: string;    // base64, 32 bytes
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** True when the OS offers a built-in authenticator (Touch ID, Windows Hello). */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false;
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

// PRF is not in every TS DOM lib version; describe just what we read.
interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

function prfFirst(cred: Credential | null): ArrayBuffer | undefined {
  if (!cred) throw new Error('Touch ID returned no credential');
  const ext = (cred as PublicKeyCredential).getClientExtensionResults() as PrfExtensionResults;
  return ext.prf?.results?.first;
}

function requirePrf(first: ArrayBuffer | undefined): string {
  if (!first) throw new Error(UNSUPPORTED);
  return toBase64(new Uint8Array(first));
}

async function getPrf(creds: CredentialsContainer, credentialId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const cred = await creds.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  });
  return requirePrf(prfFirst(cred));
}

/** Create a new Touch ID credential and read its PRF secret for a fresh salt. */
export async function registerBiometric(creds: CredentialsContainer = navigator.credentials): Promise<BiometricRegistration> {
  const salt = randomBytes(SALT_LENGTH);
  const cred = await creds.create({
    publicKey: {
      rp: { name: 'Auto Wallet' },
      user: { id: randomBytes(16), name: 'Auto Wallet', displayName: 'Auto Wallet' },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },   // ES256
        { type: 'public-key', alg: -257 }, // RS256 (Windows Hello)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  });
  if (!cred) throw new Error('Touch ID returned no credential');
  const ext = (cred as PublicKeyCredential).getClientExtensionResults() as PrfExtensionResults;
  if (ext.prf?.enabled === false || ext.prf === undefined) throw new Error(UNSUPPORTED);

  const rawId = new Uint8Array((cred as PublicKeyCredential).rawId);
  // Some authenticators only report `enabled` at creation; one get() reads the secret.
  const prfOutput = ext.prf.results?.first
    ? requirePrf(ext.prf.results.first)
    : await getPrf(creds, rawId, salt);

  return { credentialId: toBase64Url(rawId), prfSalt: toBase64(salt), prfOutput };
}

/** Ask for Touch ID and return the PRF secret of the saved credential. */
export async function evaluateBiometric(
  credentialId: string,
  prfSalt: string,
  creds: CredentialsContainer = navigator.credentials,
): Promise<string> {
  return getPrf(creds, fromBase64Url(credentialId), fromBase64(prfSalt));
}

/** Readable message for a failed WebAuthn call (the user cancelling is the usual case). */
export function biometricErrorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Touch ID was cancelled or timed out.';
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
