// Settings card to turn Touch ID / Windows Hello unlock on or off.
// Off by default; turning it on needs the password once.

import React, { useEffect, useState } from 'react';
import { callBackground } from './api';
import { biometricName } from './BiometricUnlockButton';
import {
  isPlatformAuthenticatorAvailable,
  registerBiometric,
  biometricErrorMessage,
} from '../lib/biometric-webauthn';
import type { BiometricStatus } from '../lib/key-manager.core';

export function BiometricSettingsCard() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = biometricName();

  useEffect(() => {
    isPlatformAuthenticatorAvailable().then(setAvailable);
    callBackground<BiometricStatus>('getBiometricStatus').then((s) => setEnabled(s.enabled));
  }, []);

  async function turnOn() {
    if (!password) { setError('Password is required'); return; }
    setBusy(true);
    setError('');
    try {
      // Check the password first so a typo doesn't leave an unused Touch ID entry behind.
      await callBackground('verifyPassword', { password });
      const reg = await registerBiometric();
      await callBackground('enableBiometric', { password, ...reg });
    } catch (e) {
      console.error('[Auto-Wallet] Enabling biometric unlock failed:', e);
      setError(biometricErrorMessage(e));
      setBusy(false);
      return;
    }
    setEnabled(true);
    setAsking(false);
    setPassword('');
    setBusy(false);
  }

  async function turnOff() {
    setError('');
    await callBackground('disableBiometric');
    setEnabled(false);
  }

  return (
    <div className="card">
      <p className="section-label" style={{ marginBottom: 10 }}>{name} Unlock</p>
      <div className="settings-row">
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>Unlock with {name}</p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {available === false
              ? `${name} is not available on this device`
              : 'Your password still works too'}
          </p>
        </div>
        <button
          onClick={() => (enabled ? turnOff() : setAsking(!asking))}
          className={`toggle ${enabled ? 'on' : ''}`}
          disabled={available === false && !enabled}
          aria-pressed={enabled}
          aria-label={enabled ? `Turn off ${name} unlock` : `Turn on ${name} unlock`}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {asking && !enabled && (
        <div className="stack stack-xs" style={{ marginTop: 10 }}>
          <input
            type="password"
            className="input-field"
            placeholder="Enter password to turn on"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && turnOn()}
            autoFocus
          />
          <button onClick={turnOn} disabled={busy} className="btn-primary">
            {busy ? `Waiting for ${name}...` : `Turn on ${name}`}
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
