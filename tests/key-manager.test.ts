import { test, expect, beforeEach, describe } from 'bun:test';
import { fake, resetFakeChrome } from './helpers/fake-chrome';
import { encrypt } from '../src/lib/crypto';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';

const km = await import('../src/lib/key-manager');

const PW = 'correct horse battery';
const PK1 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const PK2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const PK_OTHER = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const MNEMONIC = 'test test test test test test test test test test test junk';
const ADDR1 = privateKeyToAccount(PK1).address;
const ADDR2 = privateKeyToAccount(PK2).address;
const ADDR_OTHER = privateKeyToAccount(PK_OTHER).address;
const ADDR_MNEMONIC = mnemonicToAccount(MNEMONIC).address;
const LEDGER_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const WATCH_ADDR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const local = () => fake.chrome.storage.local._dump() as Record<string, any>;
const session = () => fake.chrome.storage.session._dump() as Record<string, any>;

/** Simulate the MV3 worker being stopped and started: memory gone, session kept. */
function restartWorker() {
  km.forgetInMemoryStateForTests();
}

/** Storage exactly as v0.18.x wrote it: per-account salted blobs + legacy verifier. */
async function seedLegacyWallet(opts: { withVerifier?: boolean; straggler?: boolean } = {}) {
  const accounts: any[] = [
    { id: 'a1', label: 'Account 1', address: ADDR1, createdAt: 1, type: 'private', source: 'privateKey', encrypted: await encrypt(PK1, PW) },
    { id: 'a2', label: 'Account 2', address: ADDR_MNEMONIC, createdAt: 2, type: 'private', source: 'mnemonic', encrypted: await encrypt(MNEMONIC, PW) },
    { id: 'l1', label: 'Ledger', address: LEDGER_ADDR, createdAt: 3, type: 'ledger', derivationPath: "44'/60'/0'/0/0" },
    { id: 'w1', label: 'Watch', address: WATCH_ADDR, createdAt: 4, type: 'watchOnly', source: 'watchOnly' },
    // Very old entries have no `type` at all.
    { id: 'a3', label: 'Old', address: ADDR2, createdAt: 5, encrypted: await encrypt(PK2, PW) },
  ];
  if (opts.straggler) {
    accounts.push({ id: 's1', label: 'Other pw', address: ADDR_OTHER, createdAt: 6, type: 'private', source: 'privateKey', encrypted: await encrypt(PK_OTHER, 'some older password') });
  }
  const data: Record<string, unknown> = { accounts, active_account_id: 'a1' };
  if (opts.withVerifier !== false) {
    data.password_verifier = await encrypt('auto-wallet-verifier-v1', PW);
  }
  await fake.chrome.storage.local.set(data);
}

beforeEach(async () => {
  await km.lock();
  await resetFakeChrome();
});

describe('first-time setup guards (item 11)', () => {
  test('creating or importing a wallet when one exists is refused and changes nothing', async () => {
    await km.createWallet(PW);
    const before = JSON.stringify(local());

    await expect(km.createWallet('another password')).rejects.toThrow(/already exists/);
    await expect(km.importPrivateKey(PK2, 'another password')).rejects.toThrow(/already exists/);
    await expect(km.importMnemonic(MNEMONIC, 'another password')).rejects.toThrow(/already exists/);
    await expect(km.setupLedgerWallet('another password', [{ address: LEDGER_ADDR, derivationPath: "44'/60'/0'/0/0" }]))
      .rejects.toThrow(/already exists/);

    expect(JSON.stringify(local())).toBe(before);
  });

  test('a legacy single-key wallet also counts as existing', async () => {
    await fake.chrome.storage.local.set({ encrypted_private_key: await encrypt(PK1, PW) });
    await expect(km.createWallet('x-password')).rejects.toThrow(/already exists/);
  });
});

describe('session never holds the password (item 15)', () => {
  test('after create / unlock / add-account, the password is nowhere in session storage', async () => {
    await km.createWallet(PW);
    await km.addAccountPrivateKey(PK2);
    expect(JSON.stringify(session())).not.toContain(PW);
    await km.lock();
    await km.unlock(PW);
    expect(JSON.stringify(session())).not.toContain(PW);
    expect(JSON.stringify(session())).not.toContain('masterPassword');
  });

  test('signing still works after a worker restart (key restored from session)', async () => {
    await km.importPrivateKey(PK1, PW);
    restartWorker();
    expect(await km.isUnlocked()).toBe(true);
    expect((await km.getAccount()).address).toBe(ADDR1);
  });

  test('accounts can be added after a worker restart', async () => {
    await km.importPrivateKey(PK1, PW);
    restartWorker();
    expect(await km.addAccountPrivateKey(PK2)).toBe(ADDR2);
    await km.lock();
    await km.unlock(PW);
    await km.switchAccount((await km.listAccounts())[1]!.id);
    expect((await km.getAccount()).address).toBe(ADDR2);
  });

  test('an old-format session holding a password is discarded, not used', async () => {
    await seedLegacyWallet();
    await fake.chrome.storage.session.set({ aw_session: { masterPassword: PW, activeAccountId: 'a1', lastActivity: Date.now() } });
    restartWorker();
    expect(await km.isUnlocked()).toBe(false);
    expect(session().aw_session).toBeUndefined();
  });
});

describe('upgrade from the old storage format (item 15)', () => {
  test('unlock migrates every account; keys, mnemonic, ledger and watch-only all survive', async () => {
    await seedLegacyWallet();

    expect(await km.unlock(PW)).toBe(ADDR1);

    const stored = local();
    expect(stored.vault.version).toBe(2);
    expect(stored.password_verifier).toBeUndefined();
    for (const a of stored.accounts) expect(a.encrypted).toBeUndefined();
    expect(stored.accounts.filter((a: any) => a.sealed).map((a: any) => a.id).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(stored.accounts.map((a: any) => a.address)).toEqual([ADDR1, ADDR_MNEMONIC, LEDGER_ADDR, WATCH_ADDR, ADDR2]);

    // Every private account still signs as the same address.
    for (const [id, addr] of [['a1', ADDR1], ['a2', ADDR_MNEMONIC], ['a3', ADDR2]] as const) {
      await km.switchAccount(id);
      expect((await km.getAccount()).address).toBe(addr);
    }
    expect(await km.exportPrivateKey('a1', PW)).toBe(PK1);
    expect(await km.exportPrivateKey('a2', PW)).toBe(MNEMONIC);

    // And the migrated wallet unlocks again, with the same password only.
    await km.lock();
    await expect(km.unlock('wrong password')).rejects.toThrow();
    expect(await km.unlock(PW)).toBe(ADDR2); // last active account was a3
  });

  test('very old wallet without a verifier migrates too', async () => {
    await seedLegacyWallet({ withVerifier: false });
    await km.unlock(PW);
    expect(local().vault.version).toBe(2);
    expect((await km.getAccount()).address).toBe(ADDR1);
  });

  test('legacy single-key storage migrates', async () => {
    await fake.chrome.storage.local.set({ encrypted_private_key: await encrypt(PK1, PW) });
    expect(await km.unlock(PW)).toBe(ADDR1);
    expect(local().encrypted_private_key).toBeUndefined();
    expect(local().accounts[0].sealed).toBeDefined();
    await km.lock();
    expect(await km.unlock(PW)).toBe(ADDR1);
  });

  test('ledger-only legacy wallet migrates its verifier', async () => {
    await fake.chrome.storage.local.set({
      accounts: [{ id: 'l1', label: 'Ledger', address: LEDGER_ADDR, createdAt: 1, type: 'ledger', derivationPath: "44'/60'/0'/0/0" }],
      password_verifier: await encrypt('auto-wallet-verifier-v1', PW),
    });
    expect(await km.unlock(PW)).toBe(LEDGER_ADDR);
    expect(local().vault.version).toBe(2);
    expect(local().password_verifier).toBeUndefined();
    await km.lock();
    await expect(km.unlock('nope-nope')).rejects.toThrow();
  });

  test('wrong password during upgrade changes nothing', async () => {
    await seedLegacyWallet();
    const before = JSON.stringify(local());
    await expect(km.unlock('wrong password')).rejects.toThrow();
    expect(JSON.stringify(local())).toBe(before);
  });

  test('an account encrypted with a different password does not block unlock', async () => {
    await seedLegacyWallet({ straggler: true });
    expect(await km.unlock(PW)).toBe(ADDR1);

    const straggler = local().accounts.find((a: any) => a.id === 's1');
    expect(straggler.encrypted).toBeDefined(); // left untouched
    expect(straggler.sealed).toBeUndefined();

    await expect(km.switchAccount('s1')).rejects.toThrow(/different password/);
    // Its key is still recoverable with the password it was made with.
    expect(await km.exportPrivateKey('s1', 'some older password')).toBe(PK_OTHER);
  });
});
