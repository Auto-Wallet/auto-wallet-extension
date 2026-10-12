import { test, expect, describe } from 'bun:test';
import { registerBiometric, evaluateBiometric, toBase64Url, fromBase64Url } from '../src/lib/biometric-webauthn';

const SECRET = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const RAW_ID = new Uint8Array([0xfb, 0xff, 0x01, 0x02, 0x3e, 0x3f]);

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Fake navigator.credentials. `prfOnCreate` = whether create() already returns the secret. */
function fakeCreds(opts: { prfEnabled: boolean; prfOnCreate?: boolean; prfOnGet?: boolean }) {
  const calls: { kind: 'create' | 'get'; options: any }[] = [];
  const cred = (results: any) => ({
    rawId: RAW_ID.buffer,
    getClientExtensionResults: () => results,
  });
  const creds = {
    create: async (options: any) => {
      calls.push({ kind: 'create', options });
      return cred({
        prf: opts.prfEnabled
          ? { enabled: true, ...(opts.prfOnCreate ? { results: { first: SECRET.buffer } } : {}) }
          : { enabled: false },
      });
    },
    get: async (options: any) => {
      calls.push({ kind: 'get', options });
      return cred(opts.prfOnGet === false ? {} : { prf: { results: { first: SECRET.buffer } } });
    },
  } as unknown as CredentialsContainer;
  return { creds, calls };
}

describe('base64url', () => {
  test('round-trips bytes that use the url-safe characters', () => {
    const s = toBase64Url(RAW_ID);
    expect(s).not.toMatch(/[+/=]/);
    expect([...fromBase64Url(s)]).toEqual([...RAW_ID]);
  });
});

describe('registerBiometric', () => {
  test('creates a platform credential that requires user verification and asks for PRF', async () => {
    const { creds, calls } = fakeCreds({ prfEnabled: true, prfOnCreate: true });
    const out = await registerBiometric(creds);

    const pk = calls[0]!.options.publicKey;
    expect(pk.authenticatorSelection.authenticatorAttachment).toBe('platform');
    expect(pk.authenticatorSelection.userVerification).toBe('required');
    const salt = new Uint8Array(pk.extensions.prf.eval.first);
    expect(salt.length).toBe(32);

    expect(out.credentialId).toBe(toBase64Url(RAW_ID));
    expect(out.prfSalt).toBe(b64(salt));
    expect(out.prfOutput).toBe(b64(SECRET));
    expect(calls.map((c) => c.kind)).toEqual(['create']);
  });

  test('when create() only says PRF is enabled, it runs one get() to read the secret', async () => {
    const { creds, calls } = fakeCreds({ prfEnabled: true, prfOnCreate: false });
    const out = await registerBiometric(creds);
    expect(calls.map((c) => c.kind)).toEqual(['create', 'get']);
    const createSalt = b64(new Uint8Array(calls[0]!.options.publicKey.extensions.prf.eval.first));
    const getSalt = b64(new Uint8Array(calls[1]!.options.publicKey.extensions.prf.eval.first));
    expect(getSalt).toBe(createSalt);
    expect(out.prfOutput).toBe(b64(SECRET));
  });

  test('a device without PRF support is refused with a clear message', async () => {
    const { creds } = fakeCreds({ prfEnabled: false });
    await expect(registerBiometric(creds)).rejects.toThrow(/does not support/i);
  });
});

describe('evaluateBiometric', () => {
  test('asks only for the saved credential, with the saved salt, and requires verification', async () => {
    const { creds, calls } = fakeCreds({ prfEnabled: true });
    const salt = b64(new Uint8Array(32).fill(9));
    const out = await evaluateBiometric(toBase64Url(RAW_ID), salt, creds);

    const pk = calls[0]!.options.publicKey;
    expect(pk.userVerification).toBe('required');
    expect(pk.allowCredentials.length).toBe(1);
    expect([...new Uint8Array(pk.allowCredentials[0].id)]).toEqual([...RAW_ID]);
    expect(b64(new Uint8Array(pk.extensions.prf.eval.first))).toBe(salt);
    expect(out).toBe(b64(SECRET));
  });

  test('no PRF result means an error, not an empty secret', async () => {
    const { creds } = fakeCreds({ prfEnabled: true, prfOnGet: false });
    await expect(evaluateBiometric(toBase64Url(RAW_ID), b64(new Uint8Array(32)), creds)).rejects.toThrow(/does not support/i);
  });
});
