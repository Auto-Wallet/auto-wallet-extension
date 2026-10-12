import React, { useState, useEffect } from 'react';
import { callBackground } from '../api';
import type { WhitelistRule } from '../../types/whitelist';
import { MANUAL_RULE_EXPIRY_OPTIONS, expiryLabel, isRuleExpired } from '../../lib/whitelist.core';

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function WhitelistPage() {
  const [rules, setRules] = useState<WhitelistRule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');
  const [contractAddress, setContractAddress] = useState('');
  const [methodSig, setMethodSig] = useState('');
  const [maxValueEth, setMaxValueEth] = useState('');
  const [maxGasLimit, setMaxGasLimit] = useState('');
  const [enableOrigin, setEnableOrigin] = useState(true);
  const [enableContract, setEnableContract] = useState(false);
  const [enableMethod, setEnableMethod] = useState(false);
  const [expiryMs, setExpiryMs] = useState<number | null>(DEFAULT_EXPIRY_MS);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Re-render every 30 s so the "time left" text stays current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { loadRules(); }, []);

  async function loadRules() {
    const r = await callBackground<WhitelistRule[]>('getRules');
    setRules(r);
  }

  async function addRule() {
    if (!label.trim()) return;
    const createdAt = Date.now();
    const rule: WhitelistRule = {
      id: crypto.randomUUID(),
      label: label.trim(),
      enabled: true,
      origin: enableOrigin && origin.trim() ? origin.trim() : null,
      contractAddress: enableContract && contractAddress.trim() ? contractAddress.trim() : null,
      methodSig: enableMethod && methodSig.trim() ? methodSig.trim() : null,
      maxValueEth: maxValueEth.trim() || null,
      maxGasLimit: maxGasLimit.trim() || null,
      chainId: null,
      createdAt,
      expiresAt: expiryMs === null ? null : createdAt + expiryMs,
    };
    await callBackground('addRule', rule);
    resetForm();
    loadRules();
  }

  async function toggleRule(id: string, enabled: boolean) {
    await callBackground('updateRule', { id, patch: { enabled } });
    loadRules();
  }

  async function deleteRule(id: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    await callBackground('removeRule', { id });
    setConfirmDeleteId(null);
    loadRules();
  }

  function resetForm() {
    setShowForm(false);
    setLabel(''); setOrigin(''); setContractAddress(''); setMethodSig('');
    setMaxValueEth(''); setMaxGasLimit('');
    setEnableOrigin(true); setEnableContract(false); setEnableMethod(false);
    setExpiryMs(DEFAULT_EXPIRY_MS);
  }

  return (
    <div className="stack stack-sm animate-in">
      <div className="row row-between">
        <p className="page-title">Auto-Sign Rules</p>
        <button onClick={() => setShowForm(!showForm)} className="btn-ghost accent">
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showForm && (
        <div className="card-form">
          <input className="input-field" placeholder="Rule name" value={label} onChange={(e) => setLabel(e.target.value)} style={{ fontFamily: 'var(--font-sans)' }} />

          <div className="row gap-sm">
            <input type="checkbox" checked={enableOrigin} onChange={(e) => setEnableOrigin(e.target.checked)} />
            <input className="input-field flex-1" placeholder="Origin (https://...)" value={origin} onChange={(e) => setOrigin(e.target.value)} disabled={!enableOrigin} />
          </div>
          <div className="row gap-sm">
            <input type="checkbox" checked={enableContract} onChange={(e) => setEnableContract(e.target.checked)} />
            <input className="input-field flex-1" placeholder="Contract (0x...)" value={contractAddress} onChange={(e) => setContractAddress(e.target.value)} disabled={!enableContract} />
          </div>
          <div className="row gap-sm">
            <input type="checkbox" checked={enableMethod} onChange={(e) => setEnableMethod(e.target.checked)} />
            <input className="input-field flex-1" placeholder="Selector (0x1234abcd)" value={methodSig} onChange={(e) => setMethodSig(e.target.value)} disabled={!enableMethod} />
          </div>

          <div className="grid-2">
            <input className="input-field" placeholder="Max ETH" value={maxValueEth} onChange={(e) => setMaxValueEth(e.target.value)} />
            <input className="input-field" placeholder="Max gas" value={maxGasLimit} onChange={(e) => setMaxGasLimit(e.target.value)} />
          </div>

          <div className="stack stack-xs">
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Expires after</span>
            <div className="row gap-xs" style={{ flexWrap: 'wrap' }}>
              {MANUAL_RULE_EXPIRY_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setExpiryMs(opt.ms)}
                  className={`theme-option ${expiryMs === opt.ms ? 'active' : ''}`}
                  aria-pressed={expiryMs === opt.ms}
                  style={{ flex: 1, minWidth: 44 }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {expiryMs === null && (
              <div className="confirm-warning" style={{ fontSize: 11 }}>
                This rule will auto-sign matching requests until you turn it off or delete it.
              </div>
            )}
          </div>

          <button onClick={addRule} className="btn-primary">Save Rule</button>
        </div>
      )}

      {rules.length === 0 && !showForm && (
        <div className="empty-state">No auto-sign rules yet</div>
      )}

      {rules.map((rule) => {
        const isConfirmingDelete = confirmDeleteId === rule.id;
        const expired = isRuleExpired(rule, now);
        return (
          <div key={rule.id} className="card" style={expired ? { opacity: 0.6 } : undefined}>
            <div className="row row-between" style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{rule.label}</span>
              <div className="row gap-xs">
                <button
                  onClick={() => toggleRule(rule.id, !rule.enabled)}
                  className={`toggle ${rule.enabled ? 'on' : ''}`}
                  aria-pressed={rule.enabled}
                  aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
                  title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                >
                  <span className="toggle-knob" />
                </button>
                {isConfirmingDelete ? (
                  <span className="row gap-xs">
                    <button
                      onClick={() => deleteRule(rule.id)}
                      className="btn-ghost danger"
                    >
                      Remove
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="btn-ghost"
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="btn-ghost danger"
                  >
                    Del
                  </button>
                )}
              </div>
            </div>
            <div className="rule-detail">
              {rule.origin && <div>origin: {rule.origin}</div>}
              {rule.contractAddress && <div>to: {rule.contractAddress.slice(0, 14)}...</div>}
              {rule.methodSig && <div>method: {rule.methodSig}</div>}
              {rule.maxValueEth && <div>max: {rule.maxValueEth} ETH</div>}
              {rule.maxGasLimit && <div>gas cap: {rule.maxGasLimit}</div>}
              <div style={expired ? { color: 'var(--danger)' } : undefined}>expires: {expiryLabel(rule, now)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
