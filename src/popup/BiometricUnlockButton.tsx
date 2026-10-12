// "Unlock with Touch ID" button shown under the password field when the user
// turned biometric unlock on in Settings. Renders nothing otherwise.

import React, { useEffect, useState } from 'react';
import { callBackground } from './api';
import { evaluateBiometric, biometricErrorMessage } from '../lib/biometric-webauthn';
import type { BiometricStatus } from '../lib/key-manager.core';

/** What the OS calls its built-in check, for button text. */
export function biometricName(): string {
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return 'fingerprint';
}

export function BiometricUnlockButton({ onUnlocked }: { onUnlocked: () => void }) {
  const [status, setStatus] = useState<BiometricStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    callBackground<BiometricStatus>('getBiometricStatus').then(setStatus);
  }, []);

  if (!status || !status.enabled) return null;
  const { credentialId, prfSalt } = status;

  async function handleClick() {
    setBusy(true);
    setError('');
    try {
      const prfOutput = await evaluateBiometric(credentialId, prfSalt);
      await callBackground('unlockWithBiometric', { prfOutput });
    } catch (e) {
      console.error('[Auto-Wallet] Biometric unlock failed:', e);
      setError(biometricErrorMessage(e));
      setBusy(false);
      return;
    }
    onUnlocked();
  }

  return (
    <>
      <button type="button" onClick={handleClick} disabled={busy} className="btn-secondary">
        {busy ? 'Waiting for ' + biometricName() + '...' : 'Unlock with ' + biometricName()}
      </button>
      {error && <p className="error-text" style={{ textAlign: 'center' }}>{error}</p>}
    </>
  );
}
