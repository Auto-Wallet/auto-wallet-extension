export interface Network {
  chainId: number;
  name: string;
  rpcUrl: string;
  symbol: string;        // native token symbol, e.g. "ETH"
  decimals: number;      // native token decimals, usually 18
  blockExplorerUrl?: string;
  /** True for any network present in the user's NETWORKS storage. Seeded
   *  presets land here on first run; all entries are editable/deletable. */
  isCustom?: boolean;
}

/**
 * Preset chains seeded into the user's network list on first run.
 *
 * Behavior:
 *  - Fresh install: every entry is copied into NETWORKS storage.
 *  - Upgrade adding new presets: only chainIds not previously seeded are added.
 *  - If the user already has a network with the same chainId, theirs is kept.
 *  - Once seeded, an entry behaves identically to a user-added network:
 *    fully editable, deletable, and not re-added if removed.
 *
 * The first entry doubles as the "no network found" fallback in
 * `getActiveNetwork`, so keep Ethereum mainnet first.
 */
export const PRESET_NETWORKS: Network[] = [
  // --- Ethereum ---
  { chainId: 1,        name: 'Ethereum',          rpcUrl: 'https://eth.drpc.org',                                   symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://etherscan.io' },
  { chainId: 11155111, name: 'Ethereum Sepolia',  rpcUrl: 'https://sepolia.drpc.org',                               symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://sepolia.etherscan.io' },
  { chainId: 17000,    name: 'Ethereum Holesky',  rpcUrl: 'https://holesky.drpc.org',                               symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://holesky.etherscan.io' },

  // --- Polygon ---
  { chainId: 137,      name: 'Polygon',           rpcUrl: 'https://polygon.drpc.org',                               symbol: 'POL',  decimals: 18, blockExplorerUrl: 'https://polygonscan.com' },
  { chainId: 80002,    name: 'Polygon Amoy',      rpcUrl: 'https://rpc-amoy.polygon.technology',                    symbol: 'POL',  decimals: 18, blockExplorerUrl: 'https://amoy.polygonscan.com' },
  { chainId: 1101,     name: 'Polygon zkEVM',     rpcUrl: 'https://zkevm-rpc.com',                                  symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://zkevm.polygonscan.com' },

  // --- BNB Smart Chain ---
  { chainId: 56,       name: 'BNB Smart Chain',   rpcUrl: 'https://bsc-dataseed.binance.org',                       symbol: 'BNB',  decimals: 18, blockExplorerUrl: 'https://bscscan.com' },
  { chainId: 97,       name: 'BSC Testnet',       rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',         symbol: 'tBNB', decimals: 18, blockExplorerUrl: 'https://testnet.bscscan.com' },

  // --- Arbitrum ---
  { chainId: 42161,    name: 'Arbitrum One',      rpcUrl: 'https://arb1.arbitrum.io/rpc',                           symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://arbiscan.io' },
  { chainId: 42170,    name: 'Arbitrum Nova',     rpcUrl: 'https://nova.arbitrum.io/rpc',                           symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://nova.arbiscan.io' },
  { chainId: 421614,   name: 'Arbitrum Sepolia',  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',                 symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://sepolia.arbiscan.io' },

  // --- Optimism ---
  { chainId: 10,       name: 'Optimism',          rpcUrl: 'https://mainnet.optimism.io',                            symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://optimistic.etherscan.io' },
  { chainId: 11155420, name: 'Optimism Sepolia',  rpcUrl: 'https://sepolia.optimism.io',                            symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://sepolia-optimism.etherscan.io' },

  // --- Base ---
  { chainId: 8453,     name: 'Base',              rpcUrl: 'https://mainnet.base.org',                               symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://basescan.org' },
  { chainId: 84532,    name: 'Base Sepolia',      rpcUrl: 'https://sepolia.base.org',                               symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://sepolia.basescan.org' },

  // --- Avalanche ---
  { chainId: 43114,    name: 'Avalanche C-Chain', rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',                  symbol: 'AVAX', decimals: 18, blockExplorerUrl: 'https://snowtrace.io' },
  { chainId: 43113,    name: 'Avalanche Fuji',    rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',             symbol: 'AVAX', decimals: 18, blockExplorerUrl: 'https://testnet.snowtrace.io' },

  // --- Others ---
  // Networks used by the default token snapshot from auto-desktop.
  { chainId: 146,      name: 'Sonic',             rpcUrl: 'https://rpc.soniclabs.com',                              symbol: 'S',    decimals: 18 },
  { chainId: 196,      name: 'X Layer',           rpcUrl: 'https://rpc.xlayer.tech',                                symbol: 'OKB',  decimals: 18 },
  { chainId: 480,      name: 'World Chain',       rpcUrl: 'https://worldchain-mainnet.g.alchemy.com/public',         symbol: 'ETH',  decimals: 18 },
  { chainId: 592,      name: 'Astar',             rpcUrl: 'https://evm.astar.network',                               symbol: 'ASTR', decimals: 18 },
  { chainId: 1088,     name: 'Metis',             rpcUrl: 'https://andromeda.metis.io/?owner=1088',                  symbol: 'METIS', decimals: 18 },
  { chainId: 250,      name: 'Fantom',            rpcUrl: 'https://rpc.fantom.network',                             symbol: 'FTM',  decimals: 18, blockExplorerUrl: 'https://ftmscan.com' },
  { chainId: 100,      name: 'Gnosis',            rpcUrl: 'https://rpc.gnosischain.com',                            symbol: 'xDAI', decimals: 18, blockExplorerUrl: 'https://gnosisscan.io' },
  { chainId: 59144,    name: 'Linea',             rpcUrl: 'https://rpc.linea.build',                                symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://lineascan.build' },
  { chainId: 324,      name: 'zkSync Era',        rpcUrl: 'https://mainnet.era.zksync.io',                          symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://explorer.zksync.io' },
  { chainId: 534352,   name: 'Scroll',            rpcUrl: 'https://rpc.scroll.io',                                  symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://scrollscan.com' },
  { chainId: 5000,     name: 'Mantle',            rpcUrl: 'https://rpc.mantle.xyz',                                 symbol: 'MNT',  decimals: 18, blockExplorerUrl: 'https://explorer.mantle.xyz' },
  { chainId: 42220,    name: 'Celo',              rpcUrl: 'https://forno.celo.org',                                 symbol: 'CELO', decimals: 18, blockExplorerUrl: 'https://celoscan.io' },
  { chainId: 1284,     name: 'Moonbeam',          rpcUrl: 'https://rpc.api.moonbeam.network',                       symbol: 'GLMR', decimals: 18, blockExplorerUrl: 'https://moonscan.io' },
  { chainId: 1285,     name: 'Moonriver',         rpcUrl: 'https://rpc.api.moonriver.moonbeam.network',             symbol: 'MOVR', decimals: 18, blockExplorerUrl: 'https://moonriver.moonscan.io' },
  { chainId: 25,       name: 'Cronos',            rpcUrl: 'https://evm.cronos.org',                                 symbol: 'CRO',  decimals: 18, blockExplorerUrl: 'https://cronoscan.com' },
  { chainId: 81457,    name: 'Blast',             rpcUrl: 'https://rpc.blast.io',                                   symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://blastscan.io' },
  { chainId: 34443,    name: 'Mode',              rpcUrl: 'https://mainnet.mode.network',                           symbol: 'ETH',  decimals: 18, blockExplorerUrl: 'https://explorer.mode.network' },

  // --- Wanchain ---
  { chainId: 888,      name: 'Wanchain',          rpcUrl: 'https://gwan-ssl.wandevs.org:56891',                     symbol: 'WAN',  decimals: 18, blockExplorerUrl: 'https://www.wanscan.org' },
  { chainId: 999,      name: 'Wanchain Testnet',  rpcUrl: 'https://gwan-ssl.wandevs.org:46891',                     symbol: 'WAN',  decimals: 18, blockExplorerUrl: 'https://testnet.wanscan.org' },
];

/** Back-compat alias. Some legacy spots fall back to `DEFAULT_NETWORKS[0]`
 *  when storage is empty; that's still Ethereum mainnet. */
export const DEFAULT_NETWORKS: Network[] = PRESET_NETWORKS;
