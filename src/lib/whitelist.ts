// IO shell: reads rules from chrome.storage, delegates decisions to whitelist.core.
import type { WhitelistRule, AutoSignResult } from '../types/whitelist';
import { getItem, setItem, STORAGE_KEYS } from './storage';
import { evaluateRules, type TxContext } from './whitelist.core';

// Re-export core types and functions for backward compatibility
export type { TxContext } from './whitelist.core';
export type { AutoSignResult as AutoSignCheckResult } from '../types/whitelist';
export { matchesRule, checkSafetyCaps, evaluateRules, normalizeOrigin, isRuleExpired, buildTrustRule, TRUST_DURATIONS_MS, MANUAL_RULE_EXPIRY_OPTIONS, expiryLabel } from './whitelist.core';

// --- Storage ---

export async function getRules(): Promise<WhitelistRule[]> {
  return (await getItem<WhitelistRule[]>(STORAGE_KEYS.WHITELIST_RULES)) ?? [];
}

export async function saveRules(rules: WhitelistRule[]): Promise<void> {
  await setItem(STORAGE_KEYS.WHITELIST_RULES, rules);
}

export async function addRule(rule: WhitelistRule): Promise<void> {
  const rules = await getRules();
  rules.push(rule);
  await saveRules(rules);
}

export async function updateRule(id: string, patch: Partial<WhitelistRule>): Promise<void> {
  const rules = await getRules();
  const idx = rules.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error(`Rule not found: ${id}`);
  const existing = rules[idx];
  if (!existing) throw new Error(`Rule not found: ${id}`);
  rules[idx] = { ...existing, ...patch };
  await saveRules(rules);
}

export async function removeRule(id: string): Promise<void> {
  const rules = await getRules();
  await saveRules(rules.filter((r) => r.id !== id));
}

// --- Matching (thin IO wrapper around pure evaluateRules) ---

export async function checkAutoSign(ctx: TxContext): Promise<AutoSignResult> {
  const rules = await getRules();
  return evaluateRules(rules, ctx);
}
