import { copyFileSync, cpSync, mkdirSync, existsSync, writeFileSync, renameSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

const DIST = join(import.meta.dir, 'dist');
const envPath = join(import.meta.dir, '.env');

function readLocalEnv(): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
  return env;
}

const localEnv = readLocalEnv();
// Bun loads .env and .env.local; an explicit CI environment value wins.
const relayApiKey = Bun.env.RELAY_API_KEY === undefined ? '' : Bun.env.RELAY_API_KEY.trim();
if (Bun.argv.includes('--require-relay-key') && relayApiKey === '') {
  throw new Error('RELAY_API_KEY is required for release builds.');
}

// Clean and create dist
if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

async function buildEntry(entry: string, outputName: string) {
  // Use a per-entry temp directory to avoid filename collisions in parallel builds
  const tempDir = join(DIST, `_tmp_${outputName.replace('.', '_')}`);
  mkdirSync(tempDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: tempDir,
    target: 'browser',
    minify: true,
    define: {
      // Extension bundles can be unpacked. Keep the app key out of UI and
      // web-accessible scripts; only the service worker calls Relay with it.
      ...(outputName === 'background.js' ? { __RELAY_API_KEY__: JSON.stringify(relayApiKey) } : {}),
      __BCS_API_URL__: JSON.stringify(
        localEnv.BCS_API_URL
          ?? Bun.env.BCS_API_URL
          ?? 'https://balance-change-simulate-api.wanscan.org',
      ),
      // SECURITY: OKX DEX requires HMAC-signed requests, so the API key/secret/
      // passphrase are baked into the bundle here (read from the gitignored
      // .env, never committed). This mirrors the desktop app, which compiles the
      // same credentials into its binary. A published web extension exposes them
      // to anyone who unpacks the build — for a public release, move signing
      // behind a backend proxy instead of shipping the secret.
      __OKX_API_KEY__: JSON.stringify(localEnv.OKX_API_KEY ?? Bun.env.OKX_API_KEY ?? ''),
      __OKX_SECRET_KEY__: JSON.stringify(localEnv.OKX_SECRET_KEY ?? Bun.env.OKX_SECRET_KEY ?? ''),
      __OKX_PASSPHRASE__: JSON.stringify(localEnv.OKX_PASSPHRASE ?? Bun.env.OKX_PASSPHRASE ?? ''),
    },
  });
  if (!result.success) {
    console.error(`Build failed for ${entry}:`, result.logs);
    process.exit(1);
  }
  // Move output to final destination
  const output = result.outputs[0];
  if (!output) {
    console.error(`Build failed for ${entry}: no output produced`);
    process.exit(1);
  }
  const builtPath = output.path;
  const targetPath = join(DIST, outputName);
  renameSync(builtPath, targetPath);
  rmSync(tempDir, { recursive: true });
}

// Build all entries in parallel — each uses its own temp directory
await Promise.all([
  buildEntry('src/background/index.ts', 'background.js'),
  buildEntry('src/content/index.ts', 'content.js'),
  buildEntry('src/content/inpage.ts', 'inpage.js'),
  buildEntry('src/popup/index.tsx', 'popup.js'),
  buildEntry('src/confirm/index.tsx', 'confirm.js'),
  buildEntry('src/unlock/index.tsx', 'unlock-page.js'),
  buildEntry('src/ledger-picker/index.tsx', 'ledger-picker.js'),
  buildEntry('src/swap/index.tsx', 'swap.js'),
  buildEntry('src/swap-okx/index.tsx', 'swap-okx.js'),
]);

// Unlock HTML (dApp-triggered unlock popup)
writeFileSync(join(DIST, 'unlock.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unlock - Auto Wallet</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="root"></div>
  <script src="unlock-page.js"></script>
</body>
</html>`);

// Confirm HTML (transaction approval popup)
writeFileSync(join(DIST, 'confirm.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm - Auto-Wallet</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="root"></div>
  <script src="confirm.js"></script>
</body>
</html>`);

// Popup HTML
writeFileSync(join(DIST, 'popup.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auto-Wallet</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="root"></div>
  <script src="popup.js"></script>
</body>
</html>`);

// Swap HTML (full-tab cross-chain swap UI)
writeFileSync(join(DIST, 'swap.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Swap - Auto Wallet</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="root"></div>
  <script src="swap.js"></script>
</body>
</html>`);

// OKX Swap HTML (full-tab single-chain OKX DEX swap UI)
writeFileSync(join(DIST, 'swap-okx.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Swap - Auto Wallet</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="root"></div>
  <script src="swap-okx.js"></script>
</body>
</html>`);

// Ledger picker HTML
writeFileSync(join(DIST, 'ledger-picker.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Select Ledger Addresses - Auto-Wallet</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="root"></div>
  <script src="ledger-picker.js"></script>
</body>
</html>`);

// Copy CSS
copyFileSync(join(import.meta.dir, 'src/popup/styles.css'), join(DIST, 'popup.css'));
cpSync(join(import.meta.dir, 'public/token-logos'), join(DIST, 'token-logos'), { recursive: true });

// Copy manifest
copyFileSync(join(import.meta.dir, 'public/manifest.json'), join(DIST, 'manifest.json'));

// Copy pre-built icon PNGs (16, 48, 128)
mkdirSync(join(DIST, 'icons'), { recursive: true });
for (const size of [16, 48, 128]) {
  const src = join(import.meta.dir, 'public/icons', `icon${size}.png`);
  const target = join(DIST, 'icons', `icon${size}.png`);
  copyFileSync(src, target);
}

console.log('Build complete! Output: dist/');
console.log('Load as unpacked extension: chrome://extensions -> Load unpacked -> select dist/');
