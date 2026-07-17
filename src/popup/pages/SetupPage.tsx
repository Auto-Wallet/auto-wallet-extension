import React, { useState } from 'react';
import { callBackground } from '../api';
import { WalletIcon, ShieldCheckIcon, ScrollIcon } from '../icons';

type Mode = 'choose' | 'create' | 'import-pk' | 'import-mnemonic' | 'import-ledger';
type PickedLedgerAccount = { address: string; derivationPath: string; label?: string };

export function SetupPage({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('choose');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (mode !== 'create' && mode !== 'import-ledger' && !input.trim()) {
      setError('Please enter a private key or mnemonic'); return;
    }
    setLoading(true);
    setError('');
    try {
      const label = name.trim() || undefined;
      if (mode === 'create') {
        await callBackground('createWallet', { password, label });
      } else if (mode === 'import-pk') {
        const pk = input.trim().startsWith('0x') ? input.trim() : `0x${input.trim()}`;
        await callBackground('importPrivateKey', { privateKey: pk, password, label });
      } else if (mode === 'import-mnemonic') {
        await callBackground('importMnemonic', { mnemonic: input.trim(), password, label });
      }
      onDone();
    } catch (e: any) { setError(e.message); setLoading(false); }
  };

  async function handleLedgerSubmit(seeds: PickedLedgerAccount[]) {
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true);
    setError('');
    try {
      const walletName = name.trim();
      const enriched = seeds.map((seed, idx) => ({
        ...seed,
        label: seed.label ?? (idx === 0 && walletName ? walletName : undefined),
      }));
      await callBackground('setupLedgerWallet', { password, seeds: enriched });
      onDone();
    } catch (e: any) { setError(e.message); setLoading(false); }
  }

  async function openLedgerPicker() {
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true);
    setError('');
    try {
      const result = await callBackground<{ selected: PickedLedgerAccount[] }>('pickLedgerAccounts');
      await handleLedgerSubmit(result.selected);
    } catch (e: any) {
      if (e.message !== 'Ledger picker was cancelled' && e.message !== 'Ledger picker was closed') {
        setError(e.message);
      }
      setLoading(false);
    }
  }

  if (mode === 'choose') {
    return (
      <div className="center-page animate-in">
        <img src="icons/icon128.png" className="logo-mark" alt="Auto Wallet" />
        <h1>Auto Wallet</h1>
        <p className="subtitle">Auto-signing wallet for power users</p>
        <div className="stack stack-sm w-full">
          <button onClick={() => setMode('create')} className="btn-primary">
            <span className="row gap-sm row-center">
              <WalletIcon size={18} /> Create New Wallet
            </span>
          </button>
          <button onClick={() => setMode('import-pk')} className="btn-secondary">
            <span className="row gap-sm row-center">
              <ShieldCheckIcon size={18} /> Import Private Key
            </span>
          </button>
          <button onClick={() => setMode('import-mnemonic')} className="btn-secondary">
            <span className="row gap-sm row-center">
              <ScrollIcon size={18} /> Import Mnemonic
            </span>
          </button>
          <button onClick={() => setMode('import-ledger')} className="btn-secondary">
            <span className="row gap-sm row-center">
              <LedgerLogo size={18} /> Connect Ledger
            </span>
          </button>
        </div>
      </div>
    );
  }

  const passwordReady = password.length >= 8 && password === confirm;

  return (
    <div className="stack stack-sm animate-in">
      <p className="page-title">
        {mode === 'create' ? 'Create Wallet'
          : mode === 'import-pk' ? 'Import Private Key'
          : mode === 'import-mnemonic' ? 'Import Mnemonic'
          : 'Connect Ledger'}
      </p>

      <input
        className="input-field"
        placeholder={mode === 'import-ledger' ? 'Wallet name (optional)' : 'Wallet name (e.g. Main, Trading, Test...)'}
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ fontFamily: 'var(--font-sans)' }}
      />

      {(mode === 'import-pk' || mode === 'import-mnemonic') && (
        <textarea
          className="input-field"
          placeholder={mode === 'import-pk' ? '0x...' : 'word1 word2 word3 ...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      )}

      <input type="password" className="input-field" placeholder="Master password (min 8 chars)"
        value={password} onChange={(e) => setPassword(e.target.value)}
        style={{ fontFamily: 'var(--font-sans)' }} />
      <input type="password" className="input-field" placeholder="Confirm password"
        value={confirm} onChange={(e) => setConfirm(e.target.value)}
        style={{ fontFamily: 'var(--font-sans)' }} />

      {mode === 'import-ledger' && (
        <div className="stack stack-xs">
          <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Set a master password first, then connect your Ledger.
          </p>
          {!passwordReady && (
            <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Password and confirmation must match (8+ chars) before connecting.
            </p>
          )}
          {passwordReady && (
            <button onClick={openLedgerPicker} disabled={loading} className="btn-primary">
              {loading ? 'Opening...' : 'Open Ledger Picker'}
            </button>
          )}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {mode !== 'import-ledger' && (
        <button onClick={handleSubmit} disabled={loading} className="btn-primary">
          {loading ? 'Processing...' : mode === 'create' ? 'Create' : 'Import'}
        </button>
      )}
      <button onClick={() => { setMode('choose'); setError(''); setName(''); }} className="btn-ghost" style={{ alignSelf: 'center' }}>Back</button>
    </div>
  );
}

function LedgerLogo({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M0 17.59V24h9.85v-1.43H1.43v-4.98H0zm22.57 0v4.98h-8.42V24H24v-6.41h-1.43zM9.86 7.4v9.21h4.27V15.3h-2.84V7.4H9.86zM0 0v6.4h1.43V1.43h8.42V0H0zm14.15 0v1.43h8.42V6.4H24V0h-9.85z"/>
    </svg>
  );
}
