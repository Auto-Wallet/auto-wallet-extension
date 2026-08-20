import { test, expect, describe } from 'bun:test';
import { createConfirmQueue } from '../src/background/confirm-queue';

describe('confirm queue — lock rejects pending confirmations', () => {
  test('rejectAll settles every pending confirmation as not approved', async () => {
    const queue = createConfirmQueue();

    const first = new Promise<{ approved: boolean }>((resolve) => {
      queue.add('permit-1', resolve);
    });
    const second = new Promise<{ approved: boolean }>((resolve) => {
      queue.add('tx-2', resolve);
    });

    const cancelled = queue.rejectAll();

    expect(cancelled.ids).toEqual(['permit-1', 'tx-2']);
    expect(await first).toEqual({ approved: false });
    expect(await second).toEqual({ approved: false });
  });

  test('after rejectAll, a late approve cannot take the request', () => {
    const queue = createConfirmQueue();
    let settled: { approved: boolean } | undefined;
    queue.add('permit-1', (result) => {
      settled = result;
    });

    queue.rejectAll();
    const late = queue.take('permit-1');

    expect(late).toBeUndefined();
    expect(settled).toEqual({ approved: false });
  });

  test('rejectAll returns popup window ids so they can be closed', () => {
    const queue = createConfirmQueue();
    queue.add('permit-1', () => undefined);
    queue.add('tx-2', () => undefined);

    expect(queue.setWindowId('permit-1', 42)).toBe(true);
    expect(queue.setWindowId('tx-2', 99)).toBe(true);

    expect(queue.rejectAll()).toEqual({
      ids: ['permit-1', 'tx-2'],
      windowIds: [42, 99],
    });
  });

  test('setWindowId returns false when the request was already cancelled', () => {
    const queue = createConfirmQueue();
    queue.add('permit-1', () => undefined);
    queue.rejectAll();

    expect(queue.setWindowId('permit-1', 42)).toBe(false);
    expect(queue.has('permit-1')).toBe(false);
  });
});
