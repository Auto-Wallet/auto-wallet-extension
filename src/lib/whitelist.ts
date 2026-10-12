// IO shell: reads rules from chrome.storage, delegates decisions to whitelist.core.
import type { WhitelistRule, AutoSignResult } from '../types/whitelist';
import { getItem, updateItem, STORAGE_KEYS } from './storage';
import { evaluateRules, type TxContext } from './whitelist.core';

// Re-export core types and functions for backward compatibility
export type { TxContext } from './whitelist.core';
export type { AutoSignResult as AutoSignCheckResult } from '../types/whitelist';
export { matchesRule, checkSafetyCaps, evaluateRules, normalizeOrigin, isRuleExpired, buildTrustRule, TRUST_DURATIONS_MS, MANUAL_RULE_EXPIRY_OPTIONS, expiryLabel } from './whitelist.core';

// --- Storage ---

export async function getRules(): Promise<WhitelistRule[]> {
  return (await getItem<WhitelistRule[]>(STORAGE_KEYS.WHITELIST_RULES)) ?? [];
}

function updateRules(change: (rules: WhitelistRule[]) => WhitelistRule[]): Promise<WhitelistRule[]> {
  return updateItem<WhitelistRule[]>(STORAGE_KEYS.WHITELIST_RULES, (rules) => change(rules ?? []));
}

export async function addRule(rule: WhitelistRule): Promise<void> {
  await updateRules((rules) => [...rules, rule]);
}

export async function updateRule(id: string, patch: Partial<WhitelistRule>): Promise<void> {
  await updateRules((rules) => {
    const existing = rules.find((r) => r.id === id);
    if (!existing) throw new Error(`Rule not found: ${id}`);
    return rules.map((r) => (r.id === id ? { ...existing, ...patch } : r));
  });
}

export async function removeRule(id: string): Promise<void> {
  await updateRules((rules) => rules.filter((r) => r.id !== id));
}

// --- Matching (thin IO wrapper around pure evaluateRules) ---

export async function checkAutoSign(ctx: TxContext): Promise<AutoSignResult> {
  const rules = await getRules();
  return evaluateRules(rules, ctx);
}
