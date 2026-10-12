import { test, expect, describe } from 'bun:test';
import { selectResumableTxs, receiptCandidates, supersededHashes, kindAfterMined, needsMinedTx, isCancelTx, RESUME_MAX_AGE_MS } from '../src/lib/tx-resume.core';

const NOW = 1_700_000_000_000;

function entry(id: string, over: Record<string, unknown> = {}) {
  return { id, status: 'pending' as const, hash: `0x${id}`, timestamp: NOW - 60_000, chainId: 1, ...over };
}

describe('selectResumableTxs', () => {
  test('picks pending rows with a hash that are not already being polled', () => {
    const log = [
      entry('a'),
      entry('b', { status: 'confirmed' }),
      entry('c', { status: 'failed' }),
      entry('d', { hash: undefined }),
      entry('e'),
    ];
    expect(selectResumableTxs(log, NOW, new Set(['e'])).map((e) => e.id)).toEqual(['a']);
  });

  test('skips rows older than the resume window (likely dropped)', () => {
    const log = [
      entry('fresh', { timestamp: NOW - RESUME_MAX_AGE_MS + 1 }),
      entry('stale', { timestamp: NOW - RESUME_MAX_AGE_MS }),
    ];
    expect(selectResumableTxs(log, NOW, new Set()).map((e) => e.id)).toEqual(['fresh']);
  });
});

describe('receiptCandidates', () => {
  test('a plain send has only its own hash', () => {
    expect(receiptCandidates({ hash: '0xa' })).toEqual(['0xa']);
  });
  test('a row from before replacedHashes existed falls back to prevHash', () => {
    expect(receiptCandidates({ hash: '0xb', prevHash: '0xa' })).toEqual(['0xb', '0xa']);
  });
  test('all superseded hashes are checked, newest replacement first, no duplicates', () => {
    expect(receiptCandidates({ hash: '0xc', prevHash: '0xb', replacedHashes: ['0xa', '0xb'] })).toEqual(['0xc', '0xa', '0xb']);
  });
});

describe('supersededHashes', () => {
  test('first replacement records the original', () => {
    expect(supersededHashes({ hash: '0xa' })).toEqual(['0xa']);
  });
  test('a later replacement keeps every earlier hash', () => {
    expect(supersededHashes({ hash: '0xb', prevHash: '0xa', replacedHashes: ['0xa'] })).toEqual(['0xa', '0xb']);
  });
  test('an old row with only prevHash keeps it too', () => {
    expect(supersededHashes({ hash: '0xb', prevHash: '0xa' })).toEqual(['0xa', '0xb']);
  });
  test('a row without a hash cannot be replaced', () => {
    expect(() => supersededHashes({})).toThrow(/hash/);
  });
});

const ME = '0x00000000000000000000000000000000000000aa';
const cancelTx = { from: ME, to: ME.toUpperCase().replace('0X', '0x'), value: 0n, input: '0x' as const };
const transferTx = { from: ME, to: '0x00000000000000000000000000000000000000bb', value: 5n, input: '0x' as const };

describe('isCancelTx', () => {
  test('0-value, no-data send to yourself', () => {
    expect(isCancelTx(cancelTx)).toBe(true);
    expect(isCancelTx(transferTx)).toBe(false);
    expect(isCancelTx({ ...cancelTx, value: 1n })).toBe(false);
    expect(isCancelTx({ ...cancelTx, input: '0x1234' })).toBe(false);
    expect(isCancelTx({ ...cancelTx, to: null })).toBe(false);
  });
});

describe('needsMinedTx', () => {
  test('every row that was ever cancelled, old or new', () => {
    expect(needsMinedTx({ hash: '0xc2', prevHash: '0xc1', replacementKind: 'cancel' })).toBe(true);
    expect(needsMinedTx({ hash: '0xc', replacedHashes: ['0xa'], replacementKind: 'cancel' })).toBe(true);
    expect(needsMinedTx({ hash: '0xb', prevHash: '0xa', replacementKind: 'speedup' })).toBe(false);
    expect(needsMinedTx({ hash: '0xa' })).toBe(false);
  });
});

describe('kindAfterMined', () => {
  test('a cancelled row: the mined tx decides, whichever hash it is', () => {
    const row = { hash: '0xc3', prevHash: '0xc2', replacedHashes: ['0xc1', '0xc2'], replacementKind: 'cancel' as const };
    expect(kindAfterMined(row, '0xc1', cancelTx)).toBe('cancel');
    expect(kindAfterMined(row, '0xc3', cancelTx)).toBe('cancel');
    expect(kindAfterMined(row, '0xc1', transferTx)).toBeUndefined();
  });
  test('a cancelled row whose sped-up original mined → speedup', () => {
    const row = { hash: '0xc', prevHash: '0xb', replacedHashes: ['0xa', '0xb'], replacementKind: 'cancel' as const };
    expect(kindAfterMined(row, '0xb', transferTx)).toBe('speedup');
  });
  test('old cancel row (prevHash only): the original mined → not cancelled', () => {
    expect(kindAfterMined({ hash: '0xc', prevHash: '0xa', replacementKind: 'cancel' }, '0xa', transferTx)).toBeUndefined();
  });
  test('a cancelled row without the mined tx is an error, not a guess', () => {
    expect(() => kindAfterMined({ hash: '0xc', replacementKind: 'cancel' }, '0xc')).toThrow(/mined tx/);
  });
  test('speed-up: the replacement mined → speedup; the original mined → plain', () => {
    const sped = { hash: '0xb', prevHash: '0xa', replacedHashes: ['0xa'], replacementKind: 'speedup' as const };
    expect(kindAfterMined(sped, '0xb')).toBe('speedup');
    expect(kindAfterMined(sped, '0xa')).toBeUndefined();
  });
  test('a plain send stays plain', () => {
    expect(kindAfterMined({ hash: '0xa' }, '0xa')).toBeUndefined();
  });
});
