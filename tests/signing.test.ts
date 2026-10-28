import { describe, expect, test } from 'bun:test';
import { recoverMessageAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parsePersonalSignParams,
  preparePersonalSignParams,
  signPersonalMessage,
} from '../src/lib/signing';

describe('parsePersonalSignParams', () => {
  test('shows hex-encoded sign-in messages as text without changing the signed bytes', () => {
    const message = [
      'waic.wanscan.org wants you to sign in with your Ethereum account:',
      '0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200',
      '',
      'Sign in to WAIC.',
      '',
      'URI: https://waic.wanscan.org',
      'Version: 1',
      'Chain ID: 1',
      'Nonce: a1b2c3d4e5f6g7h8',
      'Issued At: 2026-10-28T00:00:00Z',
      'Expiration Time: 2026-10-28T00:05:00Z',
    ].join('\n');
    const messageHex = toHex(message);
    const payload = parsePersonalSignParams([messageHex]);

    expect(payload.message).toBe(message);
    expect(payload.messageHex).toBe(messageHex);
  });

  test('normalizes plain text messages to UTF-8 hex bytes', () => {
    const payload = parsePersonalSignParams([
      'Access limit-cover',
      '0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200',
    ]);

    expect(payload).toEqual({
      message: 'Access limit-cover',
      messageHex: toHex('Access limit-cover'),
      signer: '0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200',
    });
  });

  test('keeps hex messages as raw bytes', () => {
    const messageHex = toHex('Access limit-cover');
    const payload = parsePersonalSignParams([messageHex, undefined]);

    expect(payload.messageHex).toBe(messageHex);
    expect(payload.signer).toBeUndefined();
  });

  test.each(['登录 WAIC\n请确认钱包地址。', 'Sign in 🚀\r\nNonce: abc123', '\uFFFD is valid UTF-8'])('decodes UTF-8 text without loss: %s', (text) => {
    const messageHex = toHex(text);
    expect(parsePersonalSignParams([messageHex]).message).toBe(text);
    expect(parsePersonalSignParams([messageHex]).messageHex).toBe(messageHex);
  });

  test('treats an uppercase 0X prefix as plain text, matching the bytes sent to the signer', () => {
    const message = toHex('Sign in to WAIC.').replace('0x', '0X');
    const payload = parsePersonalSignParams([message]);
    expect(payload.message).toBe(message);
    expect(payload.messageHex).toBe(toHex(message));
  });

  test.each(['0xfffe', '0xc328', '0x686900', '0x', '0x123', toHex('hide\u202eme'), toHex('\ufeffSign in')])('keeps binary, malformed, or hidden-control messages visible as hex: %s', (hex) => {
    expect(parsePersonalSignParams([hex]).message).toBe(hex);
    expect(parsePersonalSignParams([hex]).messageHex).toBe(hex);
  });

  test('signatures over a decoded UTF-8 message still recover the original signer', async () => {
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const message = 'waic.wanscan.org wants you to sign in with your Ethereum account:\n登录 WAIC';
    const signature = await signPersonalMessage([toHex(message), account.address], account.address, account);
    expect(await recoverMessageAddress({ message, signature })).toBe(account.address);
  });

  test('signing normalized plain text recovers the signer address', async () => {
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const { messageHex } = parsePersonalSignParams(['Access limit-cover', account.address]);

    const signature = await account.signMessage({ message: { raw: messageHex } });
    const recovered = await recoverMessageAddress({
      message: 'Access limit-cover',
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  test('handler signing path signs plain text RPC params recoverable as text', async () => {
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    const signature = await signPersonalMessage(
      ['Access limit-cover', account.address],
      account.address,
      account,
    );
    const recovered = await recoverMessageAddress({
      message: 'Access limit-cover',
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  test('handler signing path signs hex RPC params as raw bytes', async () => {
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const messageHex = toHex('Access limit-cover');

    const signature = await signPersonalMessage(
      [messageHex, account.address],
      account.address,
      account,
    );
    const recovered = await recoverMessageAddress({
      message: { raw: messageHex },
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  test('handler signing path rejects mismatched requested signer', async () => {
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    await expect(signPersonalMessage(
      ['Access limit-cover', '0x0000000000000000000000000000000000000001'],
      account.address,
      account,
    )).rejects.toThrow('does not match');
  });

  test('preparePersonalSignParams validates signer before signing', () => {
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    expect(() => preparePersonalSignParams(
      ['Access limit-cover', '0x0000000000000000000000000000000000000001'],
      account.address,
    )).toThrow('does not match');
  });
});
