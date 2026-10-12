import { test, expect, describe } from 'bun:test';
import { selectResumableTxs, RESUME_MAX_AGE_MS } from '../src/lib/tx-resume.core';

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
