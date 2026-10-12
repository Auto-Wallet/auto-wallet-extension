import { test, expect, describe } from 'bun:test';
import { encrypt, decrypt } from '../src/lib/crypto';

// =============================================================
// encrypt / decrypt round-trip
// =============================================================

describe('encrypt → decrypt round-trip', () => {
  test('private key round-trip', async () => {
    const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const password = 'strongP@ssw0rd!';
    const encrypted = await encrypt(key, password);
    const decrypted = await decrypt(encrypted, password);
    expect(decrypted).toBe(key);
  });

  test('mnemonic round-trip', async () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const password = 'myPassword123';
    const encrypted = await encrypt(mnemonic, password);
    const decrypted = await decrypt(encrypted, password);
    expect(decrypted).toBe(mnemonic);
  });

  test('unicode password round-trip', async () => {
    const plaintext = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const password = '密码测试🔐';
    const encrypted = await encrypt(plaintext, password);
    const decrypted = await decrypt(encrypted, password);
    expect(decrypted).toBe(plaintext);
  });

  test('empty string round-trip', async () => {
    const plaintext = '';
    const password = 'test';
    const encrypted = await encrypt(plaintext, password);
    const decrypted = await decrypt(encrypted, password);
    expect(decrypted).toBe(plaintext);
  });
});

// =============================================================
// wrong password → decrypt fails
// =============================================================

describe('wrong password', () => {
  test('decrypt with wrong password throws', async () => {
    const plaintext = '0xdeadbeef';
    const encrypted = await encrypt(plaintext, 'correctPassword');
    await expect(decrypt(encrypted, 'wrongPassword')).rejects.toThrow();
  });

  test('even a single character difference in password fails', async () => {
    const plaintext = 'secret-data';
    const encrypted = await encrypt(plaintext, 'password1');
    await expect(decrypt(encrypted, 'password2')).rejects.toThrow();
  });
});

// =============================================================
// Randomness: each encryption produces unique output
// =============================================================

describe('randomness', () => {
  test('same plaintext + password → different ciphertext (random IV/salt)', async () => {
    const plaintext = '0xdeadbeef';
    const password = 'test';
    const enc1 = await encrypt(plaintext, password);
    const enc2 = await encrypt(plaintext, password);

    // Different IV
    expect(enc1.iv).not.toBe(enc2.iv);
    // Different salt
    expect(enc1.salt).not.toBe(enc2.salt);
    // Different ciphertext
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

    // But both decrypt to the same value
    expect(await decrypt(enc1, password)).toBe(plaintext);
    expect(await decrypt(enc2, password)).toBe(plaintext);
  });
});

// =============================================================
// Encrypted data structure
// =============================================================

describe('encrypted data structure', () => {
  test('output contains ciphertext, iv, salt as base64 strings', async () => {
    const encrypted = await encrypt('test-data', 'password');

    expect(typeof encrypted.ciphertext).toBe('string');
    expect(typeof encrypted.iv).toBe('string');
    expect(typeof encrypted.salt).toBe('string');

    // base64 strings should be non-empty
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
    expect(encrypted.iv.length).toBeGreaterThan(0);
    expect(encrypted.salt.length).toBeGreaterThan(0);

    // Verify they are valid base64 (atob should not throw)
    expect(() => atob(encrypted.ciphertext)).not.toThrow();
    expect(() => atob(encrypted.iv)).not.toThrow();
    expect(() => atob(encrypted.salt)).not.toThrow();
  });
});

// =============================================================
// Vault key (v2): one derived key seals every account
// =============================================================

import { createVaultKey, deriveVaultKey, importVaultKey, seal, unseal } from '../src/lib/crypto';

describe('vault key', () => {
  test('seal → unseal round-trip with the derived key', async () => {
    const { key, kdf } = await createVaultKey('pw-one');
    const sealed = await seal('0xsecret', key);
    expect(await unseal(sealed, key)).toBe('0xsecret');
    expect(kdf.iterations).toBe(600_000);
  });

  test('re-deriving from the same password and salt opens what was sealed', async () => {
    const { key, kdf } = await createVaultKey('pw-two');
    const sealed = await seal('mnemonic words here', key);
    const again = await deriveVaultKey('pw-two', kdf);
    expect(await unseal(sealed, again.key)).toBe('mnemonic words here');
  });

  test('wrong password cannot open it', async () => {
    const { key, kdf } = await createVaultKey('right');
    const sealed = await seal('x', key);
    const wrong = await deriveVaultKey('wrong', kdf);
    await expect(unseal(sealed, wrong.key)).rejects.toThrow();
  });

  test('exported raw key re-imports to a working key (session restore)', async () => {
    const { key, raw } = await createVaultKey('pw-three');
    const sealed = await seal('payload', key);
    const restored = await importVaultKey(raw);
    expect(await unseal(sealed, restored)).toBe('payload');
    expect(raw).not.toContain('pw-three');
  });

  test('each seal uses a fresh IV', async () => {
    const { key } = await createVaultKey('pw');
    const a = await seal('same', key);
    const b = await seal('same', key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});
