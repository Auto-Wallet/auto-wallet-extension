import { test, expect, beforeEach, describe } from 'bun:test';
import { fake, resetFakeChrome, dispatchRuntimeMessage, extensionSender } from './helpers/fake-chrome';
import { MSG_SOURCE } from '../src/types/messages';
import { encrypt } from '../src/lib/crypto';
import { privateKeyToAccount } from 'viem/accounts';

await import('../src/background/index');
const km = await import('../src/lib/key-manager');

const PW = 'correct horse battery';
const PK1 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADDR1 = privateKeyToAccount(PK1).address;

const local = () => fake.chrome.storage.local._dump() as Record<string, any>;
const session = () => fake.chrome.storage.session._dump() as Record<string, any>;

function randomB64(n: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64');
}

/** What the page hands over after a Touch ID prompt: credential id, salt and the PRF secret. */
function fakeCredential() {
  return { credentialId: 'cred-' + randomB64(8), prfSalt: randomB64(32), prfOutput: randomB64(32) };
}

beforeEach(async () => {
  await km.lock();
  await resetFakeChrome();
  await km.importPrivateKey(PK1, PW);
});

describe('biometric unlock', () => {
  test('is off until the user turns it on', async () => {
    expect(await km.getBiometricStatus()).toEqual({ enabled: false });
    await km.lock();
    await expect(km.unlockWithBiometric(randomB64(32))).rejects.toThrow(/not enabled/i);
  });

  test('after enabling, the same PRF secret unlocks the wallet', async () => {
    const cred = fakeCredential();
    await km.enableBiometric(PW, cred);
    expect(await km.getBiometricStatus()).toEqual({ enabled: true, credentialId: cred.credentialId, prfSalt: cred.prfSalt });

    await km.lock();
    expect(await km.isUnlocked()).toBe(false);
    expect(await km.unlockWithBiometric(cred.prfOutput)).toBe(ADDR1);
    expect(await km.isUnlocked()).toBe(true);
    expect((await km.getAccount()).address).toBe(ADDR1);
  });

  test('a different PRF secret does not unlock and changes nothing', async () => {
    await km.enableBiometric(PW, fakeCredential());
    await km.lock();
    const before = JSON.stringify(local());
    await expect(km.unlockWithBiometric(randomB64(32))).rejects.toThrow(/touch id/i);
    expect(await km.isUnlocked()).toBe(false);
    expect(JSON.stringify(local())).toBe(before);
  });

  test('enabling needs the right password', async () => {
    await expect(km.enableBiometric('wrong password', fakeCredential())).rejects.toThrow(/wrong password/i);
    expect(await km.getBiometricStatus()).toEqual({ enabled: false });
  });

  test('verifyPassword checks the password without changing anything', async () => {
    const before = JSON.stringify(local());
    await expect(km.verifyPassword(PW)).resolves.toBe(true);
    await expect(km.verifyPassword('wrong password')).rejects.toThrow(/wrong password/i);
    expect(JSON.stringify(local())).toBe(before);
  });

  test('a PRF secret that is not 32 bytes is refused', async () => {
    const cred = { ...fakeCredential(), prfOutput: randomB64(16) };
    await expect(km.enableBiometric(PW, cred)).rejects.toThrow(/32 bytes/);
  });

  test('neither the PRF secret nor the vault key is stored in the clear', async () => {
    const cred = fakeCredential();
    await km.enableBiometric(PW, cred);
    const vaultKeyRaw = session().aw_session.vaultKey as string;
    const stored = JSON.stringify(local());
    expect(stored).not.toContain(cred.prfOutput);
    expect(stored).not.toContain(vaultKeyRaw);
  });

  test('turning it off removes the stored key, and the password still works', async () => {
    const cred = fakeCredential();
    await km.enableBiometric(PW, cred);
    await km.disableBiometric();
    expect(await km.getBiometricStatus()).toEqual({ enabled: false });
    await km.lock();
    await expect(km.unlockWithBiometric(cred.prfOutput)).rejects.toThrow(/not enabled/i);
    expect(await km.unlock(PW)).toBe(ADDR1);
  });

  test('deleting the wallet removes it too', async () => {
    await km.enableBiometric(PW, fakeCredential());
    await km.deleteWallet();
    expect(await km.getBiometricStatus()).toEqual({ enabled: false });
  });

  test('a wallet not yet upgraded to the vault format cannot enable it', async () => {
    await km.lock();
    await resetFakeChrome();
    await fake.chrome.storage.local.set({ encrypted_private_key: await encrypt(PK1, PW) });
    await expect(km.enableBiometric(PW, fakeCredential())).rejects.toThrow(/unlock .*password/i);
  });
});

describe('popup actions', () => {
  function popup(action: string, payload?: unknown) {
    return dispatchRuntimeMessage(
      { source: MSG_SOURCE, id: 'p', type: 'popup_request', action, payload },
      extensionSender('popup.html'),
    ).then((res) => {
      if (res.error) throw new Error(res.error);
      return res.result;
    });
  }

  test('enable, lock, unlock with Touch ID, disable', async () => {
    const cred = fakeCredential();
    await popup('enableBiometric', { password: PW, ...cred });
    expect(await popup('getBiometricStatus')).toEqual({ enabled: true, credentialId: cred.credentialId, prfSalt: cred.prfSalt });
    await popup('lock');
    expect(await popup('unlockWithBiometric', { prfOutput: cred.prfOutput })).toBe(ADDR1);
    expect(await popup('isUnlocked')).toBe(true);
    await popup('disableBiometric');
    expect(await popup('getBiometricStatus')).toEqual({ enabled: false });
  });
});
