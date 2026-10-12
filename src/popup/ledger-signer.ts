// Popup-side orchestration for Ledger signing on popup-driven sends.
//
// Background prepares an unsigned tx (fills nonce, gas, fees, chainId).
// We sign the unsigned RLP via the Ledger device, re-serialize with the
// signature using viem, and ask background to broadcast. Background never
// touches the device — WebHID is unavailable in MV3 service workers.

import { parseUnits, serializeTransaction, type TransactionSerializable } from 'viem';
import { callBackground } from './api';
import { signTransaction as ledgerSignTransaction } from '../lib/ledger';
import type { FeeOverride } from './FeeEditor';

export interface SerializedTxJSON {
  type: 'eip1559' | 'legacy';
  to: `0x${string}`;
  value: string;     // bigint as decimal string
  data?: `0x${string}`;
  gas: string;       // bigint as decimal string
  nonce: number;
  chainId: number;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

interface PrepareResponse {
  unsignedHex: string;          // hex without 0x prefix
  txJson: SerializedTxJSON;
}

interface BroadcastResponse {
  hash: string;
}

interface NativeSendArgs {
  kind: 'native';
  to: string;
  amount: string;
  fee: FeeOverride | null;
  derivationPath: string;
}

interface TokenSendArgs {
  kind: 'token';
  to: string;
  amount: string;
  tokenAddress: string;
  decimals: number;
  symbol: string;
  fee: FeeOverride | null;
  derivationPath: string;
}

export type LedgerSendArgs = NativeSendArgs | TokenSendArgs;

export function hydrateTx(json: SerializedTxJSON): TransactionSerializable {
  const base = {
    type: json.type,
    to: json.to,
    value: BigInt(json.value),
    data: json.data,
    gas: BigInt(json.gas),
    nonce: json.nonce,
    chainId: json.chainId,
  };
  if (json.type === 'eip1559') {
    return {
      ...base,
      maxFeePerGas: BigInt(json.maxFeePerGas!),
      maxPriorityFeePerGas: BigInt(json.maxPriorityFeePerGas!),
    } as TransactionSerializable;
  }
  return {
    ...base,
    gasPrice: BigInt(json.gasPrice!),
  } as TransactionSerializable;
}

/** Combine viem-style tx with a Ledger {r,s,v} signature into the signed raw tx hex. */
export function buildSignedRawTx(json: SerializedTxJSON, sig: { r: `0x${string}`; s: `0x${string}`; v: number }): `0x${string}` {
  const tx = hydrateTx(json);
  if (json.type === 'eip1559') {
    return serializeTransaction(tx, {
      r: sig.r,
      s: sig.s,
      yParity: (sig.v % 2) as 0 | 1,
    });
  }
  return serializeTransaction(tx, {
    r: sig.r,
    s: sig.s,
    v: BigInt(sig.v),
  });
}

export async function signLedgerSendTx(args: LedgerSendArgs): Promise<string> {
  const prep = await callBackground<PrepareResponse>('prepareLedgerSendTx', sendArgsToPayload(args));
  const sig = await ledgerSignTransaction(args.derivationPath, prep.unsignedHex);
  const rawTx = buildSignedRawTx(prep.txJson, sig);
  const meta = {
    from: undefined as string | undefined, // background already knows from getActiveAccountInfo
    // `to`/`value` are the real tx fields; a token transfer's recipient and
    // amount go in tokenTransfer so History can show them.
    to: prep.txJson.to,
    value: prep.txJson.value,
    tokenTransfer: args.kind === 'token'
      ? {
          token: args.tokenAddress,
          symbol: args.symbol,
          decimals: args.decimals,
          amount: parseUnits(args.amount, args.decimals).toString(),
          recipient: args.to,
        }
      : undefined,
    data: prep.txJson.data,
    chainId: prep.txJson.chainId,
    origin: 'Auto Wallet',
    autoSigned: false,
    methodSelector: prep.txJson.data ? prep.txJson.data.slice(0, 10) : undefined,
    gasLimit: prep.txJson.gas,
    maxFeePerGas: prep.txJson.maxFeePerGas,
    maxPriorityFeePerGas: prep.txJson.maxPriorityFeePerGas,
    gasPrice: prep.txJson.gasPrice,
  };
  const { hash } = await callBackground<BroadcastResponse>('broadcastSignedTx', { rawTx, meta });
  return hash;
}

function sendArgsToPayload(args: LedgerSendArgs): Record<string, unknown> {
  if (args.kind === 'native') {
    return { kind: 'native', to: args.to, amount: args.amount, fee: args.fee };
  }
  return {
    kind: 'token', to: args.to, amount: args.amount,
    tokenAddress: args.tokenAddress, decimals: args.decimals, fee: args.fee,
  };
}
