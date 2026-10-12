// Pure decision functions for whitelist rule matching.
// Zero IO, zero chrome dependency — fully testable with plain data.

import { parseEther } from 'viem';
import type { WhitelistRule, AutoSignResult } from '../types/whitelist';

export interface TxContext {
  origin: string;           // dApp origin, e.g. "https://app.uniswap.org"
  to: string | null;        // contract address
  data: string | null;      // calldata hex
  value: string;            // wei, decimal string
  gasLimit: string | null;  // decimal string
  chainId: number;
}

/** Normalize a URL string to its origin (protocol + host + port). */
export function normalizeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

/**
 * Check whether a single rule matches a transaction context.
 * All enabled dimensions must match (AND logic).
 * A rule with all dimensions null never matches (safety guard).
 */
export function matchesRule(rule: WhitelistRule, ctx: TxContext): boolean {
  // Chain filter
  if (rule.chainId !== null && rule.chainId !== ctx.chainId) return false;

  // Origin dimension — STRICT equality on parsed origin to prevent prefix attacks
  // e.g. rule "https://app.uniswap.org" must NOT match "https://app.uniswap.org.evil.com"
  if (rule.origin !== null) {
    if (normalizeOrigin(ctx.origin) !== normalizeOrigin(rule.origin)) return false;
  }

  // Contract address dimension
  if (rule.contractAddress !== null) {
    if (!ctx.to) return false;
    if (ctx.to.toLowerCase() !== rule.contractAddress.toLowerCase()) return false;
  }

  // Method signature dimension (first 4 bytes of calldata)
  if (rule.methodSig !== null) {
    if (!ctx.data || ctx.data.length < 10) return false;
    const selector = ctx.data.slice(0, 10).toLowerCase();
    if (selector !== rule.methodSig.toLowerCase()) return false;
  }

  // At least one dimension must be set (don't auto-sign with an empty rule)
  if (rule.origin === null && rule.contractAddress === null && rule.methodSig === null) {
    return false;
  }

  return true;
}

/** Check safety caps (value and gas) against a matched rule. */
export function checkSafetyCaps(
  rule: WhitelistRule,
  ctx: TxContext,
): { ok: boolean; reason?: string } {
  if (rule.maxValueEth !== null) {
    const maxWei = parseEther(rule.maxValueEth);
    if (BigInt(ctx.value) > maxWei) {
      return { ok: false, reason: `Value exceeds cap (${rule.maxValueEth} ETH)` };
    }
  }
  if (rule.maxGasLimit !== null && ctx.gasLimit !== null) {
    if (BigInt(ctx.gasLimit) > BigInt(rule.maxGasLimit)) {
      return { ok: false, reason: `Gas exceeds cap (${rule.maxGasLimit})` };
    }
  }
  return { ok: true };
}

/** True once `now` has reached the rule's expiry time. Rules without one never expire. */
export function isRuleExpired(rule: WhitelistRule, now: number): boolean {
  return rule.expiresAt !== undefined && rule.expiresAt !== null && now >= rule.expiresAt;
}

/** Choices offered by "Trust this site". There is deliberately no "forever". */
export const TRUST_DURATIONS_MS: readonly number[] = [
  15 * 60 * 1000,      // 15 min
  60 * 60 * 1000,      // 1 hour
  8 * 60 * 60 * 1000,  // 8 hours
  24 * 60 * 60 * 1000, // 24 hours
];

/** Expiry choices for rules made by hand on the rules page. */
export const MANUAL_RULE_EXPIRY_OPTIONS: readonly { label: string; ms: number | null }[] = [
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '8h', ms: 8 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'No expiry', ms: null },
];

/** Short text for how long a rule has left: "No expiry", "Expired", "1h 30m left". */
export function expiryLabel(rule: WhitelistRule, now: number): string {
  if (rule.expiresAt === undefined || rule.expiresAt === null) return 'No expiry';
  if (isRuleExpired(rule, now)) return 'Expired';
  const totalMin = Math.ceil((rule.expiresAt - now) / 60_000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  let text: string;
  if (days > 0) text = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  else if (hours > 0) text = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  else text = `${mins}m`;
  return `${text} left`;
}

/** Build the time-limited origin rule created by the confirm popup's "Trust this site". */
export function buildTrustRule(origin: string, durationMs: number, now: number, id: string): WhitelistRule {
  if (!TRUST_DURATIONS_MS.includes(durationMs)) {
    throw new Error(`Unsupported trust duration: ${durationMs}`);
  }
  const domain = normalizeOrigin(origin);
  return {
    id,
    label: `Trust: ${domain}`,
    enabled: true,
    origin: domain,
    contractAddress: null,
    methodSig: null,
    maxValueEth: null,
    maxGasLimit: null,
    chainId: null,
    createdAt: now,
    expiresAt: now + durationMs,
  };
}

/**
 * Evaluate all rules against a transaction context.
 * Pure function: rules in, decision out.
 */
export function evaluateRules(rules: WhitelistRule[], ctx: TxContext, now: number = Date.now()): AutoSignResult {
  const enabledRules = rules.filter((r) => r.enabled && !isRuleExpired(r, now));

  for (const rule of enabledRules) {
    if (!matchesRule(rule, ctx)) continue;

    const caps = checkSafetyCaps(rule, ctx);
    if (!caps.ok) {
      return { allowed: false, rule, reason: caps.reason };
    }

    return { allowed: true, rule };
  }

  return { allowed: false, reason: 'No matching whitelist rule' };
}
