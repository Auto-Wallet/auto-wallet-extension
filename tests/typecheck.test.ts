import { test, expect } from 'bun:test';

// `bun build` strips types without checking them, so a missing import (e.g.
// OkxSwapPage calling `trimAmount` without importing it) ships as a runtime
// ReferenceError. Run the real compiler so the suite catches it.
test('tsc --noEmit reports no type errors', () => {
  const proc = Bun.spawnSync(['bunx', 'tsc', '--noEmit', '-p', 'tsconfig.json'], {
    cwd: `${import.meta.dir}/..`,
  });
  const output = proc.stdout.toString() + proc.stderr.toString();
  expect(output).toBe('');
  expect(proc.exitCode).toBe(0);
}, 120_000);
