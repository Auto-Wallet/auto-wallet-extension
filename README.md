<p align="center">
  <img src="public/icons/cat-transparent.png" width="100" />
</p>

<h1 align="center">Auto Wallet</h1>

<p align="center">
  Minimal auto-signing Chrome extension wallet for EVM chains
</p>

<p align="center">
  <a href="#features">Features</a> &middot;
  <a href="#getting-started">Get Started</a> &middot;
  <a href="#eip-standards">EIP Standards</a> &middot;
  <a href="#project-structure">Project Structure</a> &middot;
  <a href="#security">Security</a> &middot;
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/auto-wallet/bckpgmilngeoccpkmoeebmbjndegfojb">
    <img src="https://img.shields.io/chrome-web-store/v/bckpgmilngeoccpkmoeebmbjndegfojb?logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store&color=4f46e5" alt="Install on Chrome Web Store" />
  </a>
  <a href="https://chromewebstore.google.com/detail/auto-wallet/bckpgmilngeoccpkmoeebmbjndegfojb">
    <img src="https://img.shields.io/chrome-web-store/users/bckpgmilngeoccpkmoeebmbjndegfojb?logo=googlechrome&logoColor=white&label=Users&color=4f46e5" alt="Chrome Web Store users" />
  </a>
  <a href="https://chromewebstore.google.com/detail/auto-wallet/bckpgmilngeoccpkmoeebmbjndegfojb">
    <img src="https://img.shields.io/chrome-web-store/rating/bckpgmilngeoccpkmoeebmbjndegfojb?logo=googlechrome&logoColor=white&label=Rating&color=4f46e5" alt="Chrome Web Store rating" />
  </a>
</p>

---

## Features

### Whitelist Auto-Signing

The core feature. Configure rules with three independently toggleable dimensions:

- **Domain** — e.g. `app.uniswap.org` (all transactions from this site auto-sign)
- **Contract address** — restrict to a specific contract
- **Method selector** — restrict to a specific function (4-byte selector)

Dimensions combine with AND logic. Gas limit and value caps are always enforced as a safety net.

### Multi-Account Management

- Create or import multiple accounts (private key or mnemonic)
- Shared master password — enter once, switch accounts without re-entering
- Header dropdown for quick switching, renaming, and deleting accounts
- Export private keys with password verification

### Ledger Hardware Wallet

- Talks to the device directly over **WebHID** (no Ledger Live bridge required)
- Signs all three primitives: `eth_sendTransaction`, `personal_sign`, and EIP-712 `eth_signTypedData_v4`
- Both derivation-path standards supported, switchable per-import:
  - **Ledger Live** — `m/44'/60'/x'/0/0`
  - **Legacy / MEW** — `m/44'/60'/0'/x`
- Address selection UI scans the first N accounts on the chosen path so you can pick the one already funded
- Pairs cleanly with watch-only accounts for a hot/cold split: monitor balances in the browser, sign with the device
- Built on `@ledgerhq/hw-transport-webhid` + `@ledgerhq/hw-app-eth` — see [`src/lib/ledger.ts`](src/lib/ledger.ts)

### Token Support

- Add custom ERC-20 tokens by contract address (auto-fetches symbol & decimals)
- Token icons from Trust Wallet CDN with fallback (handles `wan`-prefixed tokens)
- Send native tokens and ERC-20 tokens directly from the wallet
- Per-chain token lists with balance display

### Built-in Cross-Chain Swap

The popup ships a dedicated **Swap** tab that aggregates cross-chain quotes
through the [xflows.wanchain.org/api/v3](https://xflows.wanchain.org/api/v3)
service — no tab-hopping to a separate bridge dApp, no signing on an
unfamiliar origin.

End-to-end inside the popup:

| Step | What the popup does | xflows endpoint |
|---|---|---|
| 1 | Fetch supported source/dest chains & tokens | `GET /supported/chains`, `GET /supported/tokens` |
| 2 | Quote with live USD value, fee breakdown, route, ETA | `POST /quote` |
| 3 | Build the source-chain transaction (calldata + value + gas) | `POST /buildTx` |
| 4 | **USDT-style allowance reset** — `approve(0)` before re-approving on legacy tokens (per CLAUDE.md rule) | n/a (local helper) |
| 5 | Sign with the active account (private key, mnemonic, or **Ledger**) | n/a (local) |
| 6 | Poll until destination tx mines, surface explorer links for both legs | `GET /status` |

The integration lives in [`src/lib/xflows.ts`](src/lib/xflows.ts); the swap UI
is under [`src/swap/`](src/swap/) (`SwapPage.tsx`, `TokenPicker.tsx`,
`index.tsx`). All requests target `https://xflows.wanchain.org/api/v3` directly
— no proprietary backend.

### Network Management

- **31 chains preloaded out of the box** — 22 mainnets + 9 testnets, seeded on first install
- Add unlimited custom EVM networks
- Search & filter by name, symbol, or chain ID
- dApp-triggered chain addition with user confirmation + HTTPS validation

<details>
<summary><strong>Full preloaded chain list</strong> (click to expand)</summary>

#### Mainnets (22)

| Chain | Chain ID | Native | Explorer |
|---|---:|---|---|
| Ethereum | `1` | ETH | [etherscan.io](https://etherscan.io) |
| Polygon | `137` | POL | [polygonscan.com](https://polygonscan.com) |
| Polygon zkEVM | `1101` | ETH | [zkevm.polygonscan.com](https://zkevm.polygonscan.com) |
| BNB Smart Chain | `56` | BNB | [bscscan.com](https://bscscan.com) |
| Arbitrum One | `42161` | ETH | [arbiscan.io](https://arbiscan.io) |
| Arbitrum Nova | `42170` | ETH | [nova.arbiscan.io](https://nova.arbiscan.io) |
| Optimism | `10` | ETH | [optimistic.etherscan.io](https://optimistic.etherscan.io) |
| Base | `8453` | ETH | [basescan.org](https://basescan.org) |
| Avalanche C-Chain | `43114` | AVAX | [snowtrace.io](https://snowtrace.io) |
| Fantom | `250` | FTM | [ftmscan.com](https://ftmscan.com) |
| Gnosis | `100` | xDAI | [gnosisscan.io](https://gnosisscan.io) |
| Linea | `59144` | ETH | [lineascan.build](https://lineascan.build) |
| zkSync Era | `324` | ETH | [explorer.zksync.io](https://explorer.zksync.io) |
| Scroll | `534352` | ETH | [scrollscan.com](https://scrollscan.com) |
| Mantle | `5000` | MNT | [explorer.mantle.xyz](https://explorer.mantle.xyz) |
| Celo | `42220` | CELO | [celoscan.io](https://celoscan.io) |
| Moonbeam | `1284` | GLMR | [moonscan.io](https://moonscan.io) |
| Moonriver | `1285` | MOVR | [moonriver.moonscan.io](https://moonriver.moonscan.io) |
| Cronos | `25` | CRO | [cronoscan.com](https://cronoscan.com) |
| Blast | `81457` | ETH | [blastscan.io](https://blastscan.io) |
| Mode | `34443` | ETH | [explorer.mode.network](https://explorer.mode.network) |
| Wanchain | `888` | WAN | [wanscan.org](https://www.wanscan.org) |

#### Testnets (9)

| Chain | Chain ID | Native | Explorer |
|---|---:|---|---|
| Ethereum Sepolia | `11155111` | ETH | [sepolia.etherscan.io](https://sepolia.etherscan.io) |
| Ethereum Holesky | `17000` | ETH | [holesky.etherscan.io](https://holesky.etherscan.io) |
| Polygon Amoy | `80002` | POL | [amoy.polygonscan.com](https://amoy.polygonscan.com) |
| BSC Testnet | `97` | tBNB | [testnet.bscscan.com](https://testnet.bscscan.com) |
| Arbitrum Sepolia | `421614` | ETH | [sepolia.arbiscan.io](https://sepolia.arbiscan.io) |
| Optimism Sepolia | `11155420` | ETH | [sepolia-optimism.etherscan.io](https://sepolia-optimism.etherscan.io) |
| Base Sepolia | `84532` | ETH | [sepolia.basescan.org](https://sepolia.basescan.org) |
| Avalanche Fuji | `43113` | AVAX | [testnet.snowtrace.io](https://testnet.snowtrace.io) |
| Wanchain Testnet | `999` | WAN | [testnet.wanscan.org](https://testnet.wanscan.org) |

The canonical list lives in [`src/types/network.ts`](src/types/network.ts) (`PRESET_NETWORKS`). On a fresh install every entry is copied into the user's network storage; on upgrade, only chain IDs not previously seeded are added (so user-deleted networks stay deleted, user-edited entries are preserved).

</details>

### Security

- **AES-256-GCM** encryption with PBKDF2 key derivation (600,000 iterations)
- Configurable auto-lock timeout (5 min to 24 hours, or never)
- Non-whitelisted transactions require manual approval via popup
- Origin spoofing protection: uses `sender.origin` from Chrome, not page-supplied values
- Strict origin matching: prevents prefix-based domain attacks
- Signer address validation in multi-account scenarios
- `wallet_addEthereumChain` requires explicit user approval + HTTPS-only RPC

### Smart Provider Injection

- **EIP-6963** provider discovery: coexists with MetaMask and other wallets
- Auto-detects `window.ethereum`: injects only when no other wallet is present
- Optional force-inject mode for legacy dApp compatibility
- dApp-triggered unlock popup when connecting to a locked wallet

## Getting Started

The easiest way is to install from the [Chrome Web Store](https://chromewebstore.google.com/detail/auto-wallet/bckpgmilngeoccpkmoeebmbjndegfojb). To build from source, follow the steps below.

### Prerequisites

- [Bun](https://bun.sh/) (v1.0+)
- Chrome or Chromium-based browser

### Install & Build

```bash
git clone https://github.com/Auto-Wallet/auto-wallet.git
cd auto-wallet
bun install
bun run build
```

Relay quotes require an app API key in the `x-api-key` header. See the
[Relay API quickstart](https://docs.relay.link/references/api/quickstart).
For local builds, copy `.env.example` to `.env.local`, set `RELAY_API_KEY`,
then rebuild. Bun loads both `.env` and `.env.local`; explicit environment
values take precedence. Keep real keys in ignored environment files.

The release workflow uses the shared GitHub Actions secret `RELAY_API_KEY`
and fails the build if it is empty. Local builds can run without a key,
but Relay requests will report that it is not configured.

Relay requests run in the extension service worker. Only this extension's
own pages may call the request bridge, which accepts the chain, quote, and
status endpoints and does not follow redirects. The key stays out of UI
and web-accessible scripts, and responses and errors redact it. Anyone
who unpacks the extension can still read the key in `background.js`;
keeping it private would require a server proxy.

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` directory

### Development

```bash
bun run build    # one-time build
```

After making changes, run `bun run build` again and click the refresh icon on `chrome://extensions`.

## EIP Standards

| EIP | Name | Status |
|-----|------|--------|
| [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) | JavaScript Ethereum Provider API | Implemented |
| [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) | Multi Injected Provider Discovery | Implemented |
| [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559) | Fee Market Transactions (Type 2) | Implemented |
| [EIP-712](https://eips.ethereum.org/EIPS/eip-712) | Typed Structured Data Signing | Implemented |
| [EIP-191](https://eips.ethereum.org/EIPS/eip-191) | Personal Sign | Implemented |
| [EIP-3085](https://eips.ethereum.org/EIPS/eip-3085) | `wallet_addEthereumChain` | Implemented |
| [EIP-3326](https://eips.ethereum.org/EIPS/eip-3326) | `wallet_switchEthereumChain` | Implemented |
| [EIP-747](https://eips.ethereum.org/EIPS/eip-747) | `wallet_watchAsset` | Implemented |

## Project Structure

```
src/
├── background/              # Service Worker
│   ├── index.ts             # Message router
│   ├── rpc-handler.ts       # EIP-1193 RPC method handling
│   ├── popup-handler.ts     # Popup UI action handling
│   ├── confirm-manager.ts   # Transaction confirmation popup
│   ├── unlock-manager.ts    # dApp-triggered unlock popup
│   └── window-utils.ts      # Popup window positioning
├── content/
│   ├── index.ts             # ISOLATED world message bridge
│   └── inpage.ts            # MAIN world EIP-1193/6963 provider
├── confirm/
│   └── index.tsx            # Transaction confirmation page
├── unlock/
│   └── index.tsx            # Unlock prompt page
├── lib/
│   ├── crypto.ts            # AES-256-GCM encrypt/decrypt
│   ├── key-manager.ts       # Multi-account key lifecycle
│   ├── network-manager.ts   # Chain management + RPC client
│   ├── token-manager.ts     # ERC-20 token CRUD + balance
│   ├── tx-logger.ts         # Transaction history
│   ├── whitelist.ts         # Auto-sign rule engine
│   └── storage.ts           # chrome.storage wrapper
├── popup/
│   ├── App.tsx              # Main app shell + routing
│   ├── api.ts               # Popup → Background messaging
│   ├── styles.css           # Design system
│   └── pages/
│       ├── AccountMenu.tsx   # Header account dropdown
│       ├── AccountPage.tsx   # Wallet home (balance + tokens)
│       ├── NetworkPage.tsx   # Chain management + search
│       ├── SettingsPage.tsx  # Config + export + danger zone
│       ├── SetupPage.tsx     # First-time wallet creation
│       ├── TxLogPage.tsx     # Transaction history
│       ├── UnlockPage.tsx    # Password unlock
│       └── WhitelistPage.tsx # Auto-sign rule management
└── types/
    ├── messages.ts           # Message protocol types
    ├── network.ts            # Network type + defaults
    ├── settings.ts           # Wallet settings type
    ├── token.ts              # ERC-20 token type
    └── whitelist.ts          # Whitelist rule type
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Chrome Extension Manifest V3 |
| Build | Bun |
| Language | TypeScript |
| UI | React |
| Signing | viem |
| Encryption | Web Crypto API |
| Fonts | Plus Jakarta Sans + JetBrains Mono |

## Security

If you discover a security vulnerability, please report it via [GitHub Issues](https://github.com/Auto-Wallet/auto-wallet/issues). Do not disclose security issues publicly until a fix is available.

## License

[MIT](LICENSE)
