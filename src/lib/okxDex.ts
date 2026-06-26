// OKX DEX Aggregator client for the browser-extension build.
//
// The desktop app proxies these calls through a Rust backend (Tauri `invoke`)
// that holds the OKX API credentials and signs each request with HMAC-SHA256.
// The extension has no native backend, so we port the same signing + HTTP logic
// to TypeScript and call `https://web3.okx.com` directly from the extension
// page. The page has `host_permissions` for that origin, so the request is not
// subject to page CORS.
//
// Credentials are injected at build time via Bun's `define` (see build.ts) and
// read from the local `.env`. They are NOT committed to git (`.env` is ignored)
// but they DO end up in the shipped JS bundle — see SECURITY note in build.ts.

declare const __OKX_API_KEY__: string;
declare const __OKX_SECRET_KEY__: string;
declare const __OKX_PASSPHRASE__: string;

const OKX_BASE_URL = 'https://web3.okx.com';

export const OKX_NATIVE_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export type OkxChain = {
  // The aggregator's supported/chain endpoint has shipped both `chainIndex`
  // (newer) and `chainId` (older) for the numeric chain id — accept either.
  chainIndex?: string;
  chainId?: string;
  chainName: string;
  dexTokenApproveAddress?: string;
  chainLogoUrl?: string;
  iconUrl?: string;
  logoUrl?: string;
};

export type OkxToken = {
  chainIndex: string;
  decimals: string;
  tokenContractAddress: string;
  tokenLogoUrl?: string;
  tokenName: string;
  tokenSymbol: string;
};

export type OkxTokenInfo = {
  decimal?: string;
  isHoneyPot?: boolean;
  taxRate?: string;
  tokenContractAddress?: string;
  tokenSymbol?: string;
  tokenUnitPrice?: string | null;
};

export type OkxDexRoute = {
  dexProtocol?: {
    dexName?: string;
    percent?: string;
  };
  fromToken?: OkxTokenInfo;
  toToken?: OkxTokenInfo;
};

export type OkxQuote = {
  chainIndex: string;
  swapMode?: string;
  fromTokenAmount: string;
  toTokenAmount: string;
  tradeFee?: string;
  estimateGasFee?: string;
  dexRouterList?: OkxDexRoute[];
  fromToken?: OkxTokenInfo;
  toToken?: OkxTokenInfo;
  priceImpactPercent?: string;
};

export type OkxTx = {
  from?: string;
  gas?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  to: string;
  value: string;
  data: string;
  minReceiveAmount?: string;
  maxSpendAmount?: string;
  slippagePercent?: string;
};

export type OkxSwap = {
  routerResult: OkxQuote;
  tx: OkxTx;
};

export type OkxApproveTransaction = {
  data: string;
  dexContractAddress: string;
  gasLimit?: string;
  gasPrice?: string;
};

export type OkxHistory = {
  chainIndex: string;
  txHash: string;
  status: 'pending' | 'success' | 'fail' | string;
  txType?: string;
  errorMsg?: string;
  fromTokenDetails?: { symbol?: string; amount?: string; tokenAddress?: string };
  toTokenDetails?: { symbol?: string; amount?: string; tokenAddress?: string };
};

type OkxEnvelope<T> = {
  code: string;
  msg?: string;
  data: T;
};

export type OkxQuoteParams = {
  chainIndex: string;
  amount: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  swapMode?: 'exactIn' | 'exactOut';
  priceImpactProtectionPercent?: string;
};

export type OkxSwapParams = OkxQuoteParams & {
  slippagePercent: string;
  userWalletAddress: string;
};

function credentials(): { apiKey: string; secretKey: string; passphrase: string } {
  const apiKey = __OKX_API_KEY__;
  const secretKey = __OKX_SECRET_KEY__;
  const passphrase = __OKX_PASSPHRASE__;
  if (!apiKey || !secretKey || !passphrase) {
    throw new Error('OKX DEX credentials are not configured for this build.');
  }
  return { apiKey, secretKey, passphrase };
}

/** base64( HMAC-SHA256(secret, message) ) — matches the OKX OK-ACCESS-SIGN spec. */
async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  let binary = '';
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/**
 * Build the OKX query string. Empty values are dropped (matching the desktop
 * backend) so the signed request path equals the path we actually fetch.
 */
function buildQuery(params: Array<[string, string]>): string {
  return params
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function okxGet<T>(path: string, params: Array<[string, string]>): Promise<T> {
  const { apiKey, secretKey, passphrase } = credentials();
  const query = buildQuery(params);
  const requestPath = query ? `${path}?${query}` : path;
  const url = `${OKX_BASE_URL}${requestPath}`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    // The signature covers the exact request path, so it must be regenerated
    // per attempt because the timestamp changes.
    const timestamp = new Date().toISOString();
    const sign = await hmacSha256Base64(secretKey, `${timestamp}GET${requestPath}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'OK-ACCESS-KEY': apiKey,
          'OK-ACCESS-SIGN': sign,
          'OK-ACCESS-TIMESTAMP': timestamp,
          'OK-ACCESS-PASSPHRASE': passphrase,
        },
      });
    } catch (e) {
      lastError = e;
      if (attempt < 3) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw new Error(`Querying OKX DEX failed: ${(e as Error).message}`);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 20) * 1000
        : 900 * (attempt + 1);
      lastError = new Error('OKX DEX rate limited');
      if (attempt < 3) {
        await sleep(wait);
        continue;
      }
      throw new Error(`OKX DEX rate limited. Retry in about ${Math.round(wait / 1000)}s.`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OKX DEX HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    return (await res.json()) as T;
  }

  throw lastError instanceof Error ? lastError : new Error('OKX DEX request failed');
}

function unwrapList<T>(res: OkxEnvelope<T[]>): T[] {
  if (res.code !== '0') throw new Error(res.msg || `OKX DEX error ${res.code}`);
  return Array.isArray(res.data) ? res.data : [];
}

function unwrapValue<T>(res: OkxEnvelope<T>): T {
  if (res.code !== '0') throw new Error(res.msg || `OKX DEX error ${res.code}`);
  return res.data;
}

export async function okxSupportedChains(): Promise<OkxChain[]> {
  return unwrapList(await okxGet<OkxEnvelope<OkxChain[]>>('/api/v6/dex/aggregator/supported/chain', []));
}

export async function okxTokens(chainIndex: string): Promise<OkxToken[]> {
  return unwrapList(
    await okxGet<OkxEnvelope<OkxToken[]>>('/api/v6/dex/aggregator/all-tokens', [['chainIndex', chainIndex]]),
  );
}

export async function okxQuote(params: OkxQuoteParams): Promise<OkxQuote> {
  const query: Array<[string, string]> = [
    ['chainIndex', params.chainIndex],
    ['amount', params.amount],
    ['fromTokenAddress', params.fromTokenAddress],
    ['toTokenAddress', params.toTokenAddress],
    ['swapMode', params.swapMode ?? 'exactIn'],
  ];
  if (params.priceImpactProtectionPercent) {
    query.push(['priceImpactProtectionPercent', params.priceImpactProtectionPercent]);
  }
  const list = unwrapList(await okxGet<OkxEnvelope<OkxQuote[]>>('/api/v6/dex/aggregator/quote', query));
  if (!list[0]) throw new Error('OKX DEX returned no quote.');
  return list[0];
}

export async function okxSwap(params: OkxSwapParams): Promise<OkxSwap> {
  const query: Array<[string, string]> = [
    ['chainIndex', params.chainIndex],
    ['amount', params.amount],
    ['fromTokenAddress', params.fromTokenAddress],
    ['toTokenAddress', params.toTokenAddress],
    ['swapMode', params.swapMode ?? 'exactIn'],
    ['slippagePercent', params.slippagePercent],
    ['userWalletAddress', params.userWalletAddress],
  ];
  if (params.priceImpactProtectionPercent) {
    query.push(['priceImpactProtectionPercent', params.priceImpactProtectionPercent]);
  }
  const list = unwrapList(await okxGet<OkxEnvelope<OkxSwap[]>>('/api/v6/dex/aggregator/swap', query));
  if (!list[0]) throw new Error('OKX DEX returned no swap transaction.');
  return list[0];
}

export async function okxApproveTransaction(
  chainIndex: string,
  tokenContractAddress: string,
  approveAmount: string,
): Promise<OkxApproveTransaction> {
  const list = unwrapList(
    await okxGet<OkxEnvelope<OkxApproveTransaction[]>>('/api/v6/dex/aggregator/approve-transaction', [
      ['chainIndex', chainIndex],
      ['tokenContractAddress', tokenContractAddress],
      ['approveAmount', approveAmount],
    ]),
  );
  if (!list[0]) throw new Error('OKX DEX returned no approval transaction.');
  return list[0];
}

export async function okxHistory(chainIndex: string, txHash: string): Promise<OkxHistory | null> {
  const data = unwrapValue(
    await okxGet<OkxEnvelope<OkxHistory | OkxHistory[] | null>>('/api/v6/dex/aggregator/history', [
      ['chainIndex', chainIndex],
      ['txHash', txHash],
      ['isFromMyProject', 'true'],
    ]),
  );
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

export function okxTokenAddress(address: string | undefined): string {
  if (!address) return OKX_NATIVE_TOKEN_ADDRESS;
  return address.toLowerCase();
}

export function okxIsNative(address: string | undefined): boolean {
  return okxTokenAddress(address) === OKX_NATIVE_TOKEN_ADDRESS;
}

export function okxTokenDecimals(token: OkxToken | null | undefined): number {
  if (!token) return 18;
  const d = Number(token.decimals);
  return Number.isFinite(d) ? d : 18;
}
