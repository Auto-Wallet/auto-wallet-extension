import { test, expect, describe } from 'bun:test';
import { selectResumableTxs, receiptCandidates, supersededHashes, RESUME_MAX_AGE_MS } from '../src/lib/tx-resume.core';

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
