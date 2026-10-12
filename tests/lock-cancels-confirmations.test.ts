import { test, expect } from 'bun:test';
import { createConfirmQueue } from '../src/background/confirm-queue';

import './helpers/fake-chrome';

const keyManager = await import('../src/lib/key-manager');

test('lock drains pending confirmations so they cannot be signed later', async () => {
  const queue = createConfirmQueue();
  const pending = new Promise<{ approved: boolean }>((resolve) => {
    queue.add('permit-1', resolve);
  });
  queue.setWindowId('permit-1', 42);

  keyManager.addLockListener(() => {
    queue.rejectAll();
  });

  await keyManager.lock();

  expect(await pending).toEqual({ approved: false });
  expect(queue.take('permit-1')).toBeUndefined();
});
