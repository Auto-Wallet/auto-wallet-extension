// Pure logic for per-site connection permissions. Zero IO.
//
// A site must be connected (approved once via eth_requestAccounts) before it
// can read the account address or ask for signatures.

export interface ConnectedSite {
  origin: string;      // e.g. "https://app.uniswap.org"
  connectedAt: number; // epoch ms
}

/** Origin of an http(s) URL, or null for anything else (labels, extension pages, …). */
export function siteOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

function requireOrigin(raw: string): string {
  const origin = siteOrigin(raw);
  if (!origin) throw new Error(`Not a web origin: ${raw}`);
  return origin;
}

export function isConnected(list: ConnectedSite[], origin: string): boolean {
  const o = siteOrigin(origin);
  return o !== null && list.some((s) => s.origin === o);
}

export function addSite(list: ConnectedSite[], origin: string, now: number): ConnectedSite[] {
  const o = requireOrigin(origin);
  if (list.some((s) => s.origin === o)) return list;
  return [...list, { origin: o, connectedAt: now }];
}

export function removeSite(list: ConnectedSite[], origin: string): ConnectedSite[] {
  const o = requireOrigin(origin);
  return list.filter((s) => s.origin !== o);
}

/**
 * Sites the wallet already worked with before connections existed: origins in
 * whitelist rules and in the tx history. Seeding them once on upgrade keeps
 * existing auto-sign setups working without a new connect prompt.
 */
export function legacyOriginsToSeed(
  rules: Array<{ origin: string | null }>,
  log: Array<{ origin: string }>,
): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    const o = r.origin ? siteOrigin(r.origin) : null;
    if (o) out.add(o);
  }
  for (const e of log) {
    const o = siteOrigin(e.origin);
    if (o) out.add(o);
  }
  return [...out];
}
