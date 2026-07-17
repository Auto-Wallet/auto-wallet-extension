import React, { useState } from 'react';
import { callBackground } from '../api';

export function UnlockPage({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleUnlock = async () => {
    if (!password) { setError('Password is required'); return; }
    setLoading(true);
    setError('');
    try {
      await callBackground('unlock', { password });
      onUnlock();
    } catch (e: any) {
      setError('Wrong password or corrupted data');
      setLoading(false);
    }
  };

  return (
    <div className="center-page animate-in">
      <img src="icons/icon128.png" className="logo-mark" alt="Auto Wallet" />
      <h1>Auto Wallet</h1>
      <p className="subtitle">Wallet is locked</p>
      <div className="stack stack-sm w-full">
        <input
          type="password"
          className="input-field"
          placeholder="Enter password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
          style={{ textAlign: 'center' }}
        />
        {error && <p className="error-text">{error}</p>}
        <button onClick={handleUnlock} disabled={loading} className="btn-primary">
          {loading ? 'Unlocking...' : 'Unlock'}
        </button>
        <p className="hint">Press Enter to unlock</p>
      </div>
    </div>
  );
}
