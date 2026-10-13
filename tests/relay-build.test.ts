import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = `${import.meta.dir}/..`;
let buildRoot: string;
beforeEach(() => {
  buildRoot = mkdtempSync(join(tmpdir(), 'auto-wallet-relay-build-'));
  copyFileSync(`${root}/build.ts`, `${buildRoot}/build.ts`);
  for (const dir of ['src', 'public', 'node_modules']) symlinkSync(`${root}/${dir}`, `${buildRoot}/${dir}`);
});
afterEach(() => rmSync(buildRoot, { recursive: true }));

test('Release builds receive the shared Relay secret and require it', () => {
  const workflow = readFileSync(`${root}/.github/workflows/release.yml`, 'utf8');
  const step = workflow.split('- name: Build extension')[1]!.split('- name: Package zip')[0]!;
  expect(step).toContain('RELAY_API_KEY: ${{ secrets.RELAY_API_KEY }}');
  expect(step).toContain('bun run build --require-relay-key');
});

test('A release build fails before packaging when the Relay key is missing', () => {
  const result = Bun.spawnSync(['bun', 'run', 'build.ts', '--require-relay-key'], {
    cwd: buildRoot, env: { ...process.env, RELAY_API_KEY: '' },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('RELAY_API_KEY is required');
});

test('The built key appears only in the background, and the message path remains in the swap UI', () => {
  const key = 'relay-bundle-test-not-a-real-key';
  const result = Bun.spawnSync(['bun', 'run', 'build.ts', '--require-relay-key'], {
    cwd: buildRoot, env: { ...process.env, RELAY_API_KEY: key },
  });
  expect(result.exitCode).toBe(0);
  const scripts = readdirSync(`${buildRoot}/dist`).filter((file) => file.endsWith('.js'));
  expect(scripts).toContain('background.js');
  for (const file of scripts) {
    expect(readFileSync(`${buildRoot}/dist/${file}`, 'utf8').includes(key)).toBe(file === 'background.js');
  }
  expect(readFileSync(`${buildRoot}/dist/swap.js`, 'utf8')).toContain('relayRequest');
});

test('Local builds read .env.local and explicit CI values take precedence', () => {
  const localKey = 'relay-local-test-key';
  const ciKey = 'relay-ci-test-key';
  writeFileSync(`${buildRoot}/.env.local`, `RELAY_API_KEY=${localKey}\n`);
  const env = { ...process.env };
  delete env.RELAY_API_KEY;
  // bun test sets NODE_ENV=test, where Bun intentionally skips .env.local.
  env.NODE_ENV = 'development';
  const localBuild = Bun.spawnSync(['bun', 'run', 'build.ts', '--require-relay-key'], { cwd: buildRoot, env });
  expect(localBuild.exitCode).toBe(0);
  expect(readFileSync(`${buildRoot}/dist/background.js`, 'utf8')).toContain(localKey);
  const ciBuild = Bun.spawnSync(['bun', 'run', 'build.ts', '--require-relay-key'], {
    cwd: buildRoot, env: { ...env, RELAY_API_KEY: ciKey },
  });
  expect(ciBuild.exitCode).toBe(0);
  const bundle = readFileSync(`${buildRoot}/dist/background.js`, 'utf8');
  expect(bundle).toContain(ciKey);
  expect(bundle).not.toContain(localKey);
});
