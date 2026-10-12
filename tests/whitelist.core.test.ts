import { test, expect, describe } from 'bun:test';
import {
  matchesRule,
  checkSafetyCaps,
  evaluateRules,
  normalizeOrigin,
  isRuleExpired,
  buildTrustRule,
  TRUST_DURATIONS_MS,
  MANUAL_RULE_EXPIRY_OPTIONS,
  expiryLabel,
  type TxContext,
} from '../src/lib/whitelist.core';
import type { WhitelistRule } from '../src/types/whitelist';

// --- Helper: build a rule with defaults ---

function makeRule(overrides: Partial<WhitelistRule> = {}): WhitelistRule {
  return {
    id: 'rule-1',
    label: 'Test rule',
    enabled: true,
    origin: null,
    contractAddress: null,
    methodSig: null,
    maxValueEth: null,
    maxGasLimit: null,
    chainId: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<TxContext> = {}): TxContext {
  return {
    origin: 'https://app.uniswap.org',
    to: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    data: '0x5ae401dc00000000000000000000000000000000',
    value: '0',
    gasLimit: '200000',
    chainId: 1,
    ...overrides,
  };
}

// =============================================================
// normalizeOrigin
// =============================================================

describe('normalizeOrigin', () => {
  test('strips path and query from URL', () => {
    expect(normalizeOrigin('https://app.uniswap.org/swap?a=1')).toBe('https://app.uniswap.org');
  });

  test('preserves port', () => {
    expect(normalizeOrigin('http://localhost:3000/index')).toBe('http://localhost:3000');
  });

  test('returns raw string for invalid URL', () => {
    expect(normalizeOrigin('not-a-url')).toBe('not-a-url');
  });
});

// =============================================================
// matchesRule — Origin dimension
// =============================================================

describe('matchesRule — origin', () => {
  test('exact origin match', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org' });
    const ctx = makeCtx({ origin: 'https://app.uniswap.org' });
    expect(matchesRule(rule, ctx)).toBe(true);
  });

  test('origin match ignores path differences', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org' });
    const ctx = makeCtx({ origin: 'https://app.uniswap.org/swap?token=ETH' });
    expect(matchesRule(rule, ctx)).toBe(true);
  });

  test('SECURITY: prevents origin prefix attack', () => {
    // rule: "https://app.uniswap.org"
    // attacker: "https://app.uniswap.org.evil.com"
    // must NOT match
    const rule = makeRule({ origin: 'https://app.uniswap.org' });
    const ctx = makeCtx({ origin: 'https://app.uniswap.org.evil.com' });
    expect(matchesRule(rule, ctx)).toBe(false);
  });

  test('SECURITY: prevents origin suffix attack', () => {
    const rule = makeRule({ origin: 'https://uniswap.org' });
    const ctx = makeCtx({ origin: 'https://fake-uniswap.org' });
    expect(matchesRule(rule, ctx)).toBe(false);
  });

  test('origin mismatch (different subdomain)', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org' });
    const ctx = makeCtx({ origin: 'https://v2.uniswap.org' });
    expect(matchesRule(rule, ctx)).toBe(false);
  });

  test('origin mismatch (http vs https)', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org' });
    const ctx = makeCtx({ origin: 'http://app.uniswap.org' });
    expect(matchesRule(rule, ctx)).toBe(false);
  });

  test('null origin means "any origin" — but needs another dimension', () => {
    const rule = makeRule({ origin: null, contractAddress: '0xABCD' });
    const ctx = makeCtx({ to: '0xabcd' });
    expect(matchesRule(rule, ctx)).toBe(true);
  });
});

// =============================================================
// matchesRule — Contract address dimension
// =============================================================

describe('matchesRule — contract address', () => {
  test('case-insensitive address match', () => {
    const rule = makeRule({ contractAddress: '0xAbCd1234567890abcdef1234567890abcdef1234' });
    const ctx = makeCtx({ to: '0xabcd1234567890ABCDEF1234567890ABCDEF1234' });
    expect(matchesRule(rule, ctx)).toBe(true);
  });

  test('address mismatch', () => {
    const rule = makeRule({ contractAddress: '0x1111111111111111111111111111111111111111' });
    const ctx = makeCtx({ to: '0x2222222222222222222222222222222222222222' });
    expect(matchesRule(rule, ctx)).toBe(false);
  });

  test('rule requires contract but tx has no to (contract creation)', () => {
    const rule = makeRule({ contractAddress: '0x1111111111111111111111111111111111111111' });
    const ctx = makeCtx({ to: null });
    expect(matchesRule(rule, ctx)).toBe(false);
  });
});

// =============================================================
// matchesRule — Method selector dimension
// =============================================================

describe('matchesRule — method selector', () => {
  test('exact 4-byte selector match', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', methodSig: '0x5ae401dc' });
    const ctx = makeCtx({ data: '0x5ae401dc0000000000000000000000000000' });
    expect(matchesRule(rule, ctx)).toBe(true);
  });

  test('case-insensitive selector match', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', methodSig: '0x5AE401DC' });
    const ctx = makeCtx({ data: '0x5ae401dc0000000000' });
    expect(matchesRule(rule, ctx)).toBe(true);
  });

  test('selector mismatch', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', methodSig: '0x5ae401dc' });
    const ctx = makeCtx({ data: '0xa9059cbb0000000000' });
    expect(matchesRule(rule, ctx)).toBe(false);
  });

  test('data too short to contain selector', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', methodSig: '0x5ae401dc' });
    const ctx = makeCtx({ data: '0x5ae4' });
    expect(matchesRule(rule, ctx)).toBe(false);
  });

  test('null data when method required', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', methodSig: '0x5ae401dc' });
    const ctx = makeCtx({ data: null });
    expect(matchesRule(rule, ctx)).toBe(false);
  });
});

// =============================================================
// matchesRule — Chain filter
// =============================================================

describe('matchesRule — chain filter', () => {
  test('chain matches', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', chainId: 137 });
    const ctx = makeCtx({ chainId: 137 });
    expect(matchesRule(rule, ctx)).toBe(true);
  });

  test('chain mismatch', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', chainId: 137 });
    const ctx = makeCtx({ chainId: 1 });
    expect(matchesRule(rule, ctx)).toBe(false);
  });

  test('null chainId means any chain', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', chainId: null });
    const ctx = makeCtx({ chainId: 42161 });
    expect(matchesRule(rule, ctx)).toBe(true);
  });
});

// =============================================================
// matchesRule — Safety: empty rule
// =============================================================

describe('matchesRule — empty rule safety', () => {
  test('rule with all dimensions null never matches', () => {
    const rule = makeRule({ origin: null, contractAddress: null, methodSig: null });
    const ctx = makeCtx();
    expect(matchesRule(rule, ctx)).toBe(false);
  });
});

// =============================================================
// matchesRule — AND logic (combined dimensions)
// =============================================================

describe('matchesRule — combined dimensions', () => {
  test('all three dimensions must match', () => {
    const rule = makeRule({
      origin: 'https://app.uniswap.org',
      contractAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      methodSig: '0x5ae401dc',
    });

    // All match
    const ctx = makeCtx();
    expect(matchesRule(rule, ctx)).toBe(true);

    // Origin wrong
    expect(matchesRule(rule, makeCtx({ origin: 'https://evil.com' }))).toBe(false);

    // Contract wrong
    expect(matchesRule(rule, makeCtx({ to: '0x0000000000000000000000000000000000000000' }))).toBe(false);

    // Method wrong
    expect(matchesRule(rule, makeCtx({ data: '0xa9059cbb00000000' }))).toBe(false);
  });
});

// =============================================================
// checkSafetyCaps — Value cap
// =============================================================

describe('checkSafetyCaps — value cap', () => {
  test('under cap → ok', () => {
    const rule = makeRule({ maxValueEth: '1.0' });
    const ctx = makeCtx({ value: '500000000000000000' }); // 0.5 ETH
    expect(checkSafetyCaps(rule, ctx).ok).toBe(true);
  });

  test('exact cap → ok (not exceeded)', () => {
    const rule = makeRule({ maxValueEth: '1.0' });
    const ctx = makeCtx({ value: '1000000000000000000' }); // exactly 1 ETH
    expect(checkSafetyCaps(rule, ctx).ok).toBe(true);
  });

  test('over cap → blocked', () => {
    const rule = makeRule({ maxValueEth: '1.0' });
    const ctx = makeCtx({ value: '1000000000000000001' }); // 1 ETH + 1 wei
    const result = checkSafetyCaps(rule, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Value exceeds cap');
  });

  test('precision: 1.1 ETH cap handles decimal correctly', () => {
    const rule = makeRule({ maxValueEth: '1.1' });
    // 1.1 ETH = 1100000000000000000 wei
    const exactCtx = makeCtx({ value: '1100000000000000000' });
    expect(checkSafetyCaps(rule, exactCtx).ok).toBe(true);

    // 1.1 ETH + 1 wei
    const overCtx = makeCtx({ value: '1100000000000000001' });
    expect(checkSafetyCaps(rule, overCtx).ok).toBe(false);
  });

  test('precision: 0.000000000000000001 ETH (1 wei) cap', () => {
    const rule = makeRule({ maxValueEth: '0.000000000000000001' });
    const exactCtx = makeCtx({ value: '1' }); // exactly 1 wei
    expect(checkSafetyCaps(rule, exactCtx).ok).toBe(true);

    const overCtx = makeCtx({ value: '2' }); // 2 wei
    expect(checkSafetyCaps(rule, overCtx).ok).toBe(false);
  });

  test('null maxValueEth → no cap enforced', () => {
    const rule = makeRule({ maxValueEth: null });
    const ctx = makeCtx({ value: '999999000000000000000000' }); // huge amount
    expect(checkSafetyCaps(rule, ctx).ok).toBe(true);
  });
});

// =============================================================
// checkSafetyCaps — Gas cap
// =============================================================

describe('checkSafetyCaps — gas cap', () => {
  test('under gas cap → ok', () => {
    const rule = makeRule({ maxGasLimit: '300000' });
    const ctx = makeCtx({ gasLimit: '200000' });
    expect(checkSafetyCaps(rule, ctx).ok).toBe(true);
  });

  test('over gas cap → blocked', () => {
    const rule = makeRule({ maxGasLimit: '300000' });
    const ctx = makeCtx({ gasLimit: '500000' });
    const result = checkSafetyCaps(rule, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Gas exceeds cap');
  });

  test('null gasLimit in context → cap not checked', () => {
    const rule = makeRule({ maxGasLimit: '300000' });
    const ctx = makeCtx({ gasLimit: null });
    expect(checkSafetyCaps(rule, ctx).ok).toBe(true);
  });
});

// =============================================================
// evaluateRules — full flow
// =============================================================

describe('evaluateRules', () => {
  test('first matching rule wins', () => {
    const rules = [
      makeRule({ id: 'r1', origin: 'https://evil.com' }),
      makeRule({ id: 'r2', origin: 'https://app.uniswap.org' }),
      makeRule({ id: 'r3', origin: 'https://app.uniswap.org' }),
    ];
    const result = evaluateRules(rules, makeCtx());
    expect(result.allowed).toBe(true);
    expect(result.rule!.id).toBe('r2'); // r2 matches first, not r3
  });

  test('disabled rules are skipped', () => {
    const rules = [
      makeRule({ id: 'r1', origin: 'https://app.uniswap.org', enabled: false }),
      makeRule({ id: 'r2', origin: 'https://app.uniswap.org', enabled: true }),
    ];
    const result = evaluateRules(rules, makeCtx());
    expect(result.allowed).toBe(true);
    expect(result.rule!.id).toBe('r2');
  });

  test('no matching rules → not allowed', () => {
    const rules = [
      makeRule({ origin: 'https://other.com' }),
    ];
    const result = evaluateRules(rules, makeCtx());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('No matching whitelist rule');
  });

  test('empty rules array → not allowed', () => {
    const result = evaluateRules([], makeCtx());
    expect(result.allowed).toBe(false);
  });

  test('matched rule blocked by value cap → not allowed with reason', () => {
    const rules = [
      makeRule({
        origin: 'https://app.uniswap.org',
        maxValueEth: '0.01',
      }),
    ];
    const ctx = makeCtx({ value: '1000000000000000000' }); // 1 ETH > 0.01 cap
    const result = evaluateRules(rules, ctx);
    expect(result.allowed).toBe(false);
    expect(result.rule).toBeDefined();
    expect(result.reason).toContain('Value exceeds cap');
  });

  test('matched rule within cap → allowed', () => {
    const rules = [
      makeRule({
        origin: 'https://app.uniswap.org',
        maxValueEth: '10',
        maxGasLimit: '500000',
      }),
    ];
    const ctx = makeCtx({ value: '1000000000000000000', gasLimit: '300000' });
    const result = evaluateRules(rules, ctx);
    expect(result.allowed).toBe(true);
  });
});


// =============================================================
// Rule expiry (time-limited auto-sign)
// =============================================================

describe('rule expiry', () => {
  const NOW = 1_700_000_000_000;

  test('rule without expiresAt never expires (pre-existing rules keep working)', () => {
    const legacy = makeRule({ origin: 'https://app.uniswap.org' });
    delete (legacy as any).expiresAt;
    expect(isRuleExpired(legacy, NOW)).toBe(false);
    expect(isRuleExpired(makeRule({ expiresAt: null }), NOW)).toBe(false);
  });

  test('rule expires exactly at expiresAt', () => {
    const rule = makeRule({ expiresAt: NOW + 1000 });
    expect(isRuleExpired(rule, NOW + 999)).toBe(false);
    expect(isRuleExpired(rule, NOW + 1000)).toBe(true);
  });

  test('expired rule does not auto-sign; same rule before expiry does', () => {
    const rule = makeRule({ origin: 'https://app.uniswap.org', expiresAt: NOW + 60_000 });
    expect(evaluateRules([rule], makeCtx(), NOW + 59_999).allowed).toBe(true);
    const after = evaluateRules([rule], makeCtx(), NOW + 60_000);
    expect(after.allowed).toBe(false);
    expect(after.rule).toBeUndefined();
  });

  test('an expired rule is skipped so a later live rule can still match', () => {
    const expired = makeRule({ id: 'old', origin: 'https://app.uniswap.org', expiresAt: NOW - 1 });
    const live = makeRule({ id: 'new', origin: 'https://app.uniswap.org', expiresAt: NOW + 5000 });
    const result = evaluateRules([expired, live], makeCtx(), NOW);
    expect(result.allowed).toBe(true);
    expect(result.rule?.id).toBe('new');
  });
});

describe('buildTrustRule', () => {
  const NOW = 1_700_000_000_000;

  test('builds an origin-only rule that ends after the chosen duration', () => {
    const oneHour = TRUST_DURATIONS_MS[1]!;
    const rule = buildTrustRule('https://app.uniswap.org/swap?x=1', oneHour, NOW, 'id-1');
    expect(rule).toEqual({
      id: 'id-1',
      label: 'Trust: https://app.uniswap.org',
      enabled: true,
      origin: 'https://app.uniswap.org',
      contractAddress: null,
      methodSig: null,
      maxValueEth: null,
      maxGasLimit: null,
      chainId: null,
      createdAt: NOW,
      expiresAt: NOW + oneHour,
    });
  });

  test('rejects durations outside the allowed list, including "forever"', () => {
    for (const d of [0, -1, 12345, Infinity, NaN]) {
      expect(() => buildTrustRule('https://a.example', d, NOW, 'x')).toThrow();
    }
  });

  test('allowed durations are all finite and at most 24 hours', () => {
    expect(TRUST_DURATIONS_MS.length).toBeGreaterThan(0);
    for (const d of TRUST_DURATIONS_MS) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    }
  });
});

describe('expiryLabel', () => {
  const base = { id: 'r', label: 'r', enabled: true, origin: 'a.com', contractAddress: null, methodSig: null, maxValueEth: null, maxGasLimit: null, chainId: null, createdAt: 0 } as WhitelistRule;
  const now = 1_700_000_000_000;
  const MIN = 60_000;

  test('rules with no expiry say so', () => {
    expect(expiryLabel(base, now)).toBe('No expiry');
    expect(expiryLabel({ ...base, expiresAt: null }, now)).toBe('No expiry');
  });

  test('expired at or after the expiry time', () => {
    expect(expiryLabel({ ...base, expiresAt: now }, now)).toBe('Expired');
    expect(expiryLabel({ ...base, expiresAt: now - 1 }, now)).toBe('Expired');
  });

  test('time left, rounded up to the next unit shown', () => {
    expect(expiryLabel({ ...base, expiresAt: now + 1 }, now)).toBe('1m left');
    expect(expiryLabel({ ...base, expiresAt: now + 14 * MIN + 1 }, now)).toBe('15m left');
    expect(expiryLabel({ ...base, expiresAt: now + 60 * MIN }, now)).toBe('1h left');
    expect(expiryLabel({ ...base, expiresAt: now + 90 * MIN }, now)).toBe('1h 30m left');
    expect(expiryLabel({ ...base, expiresAt: now + 7 * 24 * 60 * MIN }, now)).toBe('7d left');
    expect(expiryLabel({ ...base, expiresAt: now + (2 * 24 * 60 + 3 * 60) * MIN }, now)).toBe('2d 3h left');
  });
});

describe('MANUAL_RULE_EXPIRY_OPTIONS', () => {
  const MIN_MS = 60_000;
  test('offers the trust durations plus 7 days and an explicit no-expiry choice', () => {
    const ms = MANUAL_RULE_EXPIRY_OPTIONS.map((o) => o.ms);
    for (const d of TRUST_DURATIONS_MS) expect(ms).toContain(d);
    expect(ms).toContain(7 * 24 * 60 * MIN_MS);
    expect(ms).toContain(null);
  });
});
