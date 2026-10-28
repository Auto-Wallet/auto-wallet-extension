import { hexToBytes, isHex, toHex } from 'viem';
import { validateSigner } from './rpc-validation';

export interface PersonalSignPayload {
  message: string;
  messageHex: `0x${string}`;
  signer: string | undefined;
}

export interface PersonalSignAccount {
  signMessage(args: { message: { raw: `0x${string}` } }): Promise<`0x${string}`>;
}

/** Decode readable UTF-8 only; binary or lossy text must stay visible as hex. */
function displayMessage(message: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(message)) return message;
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(hexToBytes(message as `0x${string}`));
  if (toHex(text).toLowerCase() !== message.toLowerCase()) return message;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(text)) return message;
  return text;
}

/**
 * `personal_sign` signs arbitrary bytes. Dapps normally pass those bytes as a
 * 0x-prefixed hex string, but some pass plain text. Normalize both forms to the
 * byte hex that software and Ledger signers expect.
 */
export function parsePersonalSignParams(params: unknown[]): PersonalSignPayload {
  const message = params[0];
  if (typeof message !== 'string') {
    throw new Error('personal_sign requires a string message');
  }

  return {
    message: displayMessage(message),
    messageHex: isHex(message) ? message : toHex(message),
    signer: typeof params[1] === 'string' ? params[1] : undefined,
  };
}

export function preparePersonalSignParams(params: unknown[], signerAddress: string): PersonalSignPayload {
  const payload = parsePersonalSignParams(params);
  validateSigner(payload.signer, signerAddress);
  return payload;
}

export async function signPersonalMessage(
  params: unknown[],
  signerAddress: string,
  account: PersonalSignAccount,
): Promise<`0x${string}`> {
  const { messageHex } = preparePersonalSignParams(params, signerAddress);
  return signPreparedPersonalMessage(messageHex, account);
}

export async function signPreparedPersonalMessage(
  messageHex: `0x${string}`,
  account: PersonalSignAccount,
): Promise<`0x${string}`> {
  return account.signMessage({ message: { raw: messageHex } });
}
