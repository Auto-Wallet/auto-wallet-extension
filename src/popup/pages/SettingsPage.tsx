import React, { useState, useEffect } from 'react';
import { callBackground } from '../api';
import type { WalletSettings, ThemePreference } from '../../types/settings';
import type { AccountSource, AccountType } from '../../lib/key-manager.core';
import { SunIcon, MoonIcon, MonitorIcon, GlobeIcon, XIcon, GithubIcon } from '../icons';
import { DeleteDangerModal } from '../DeleteDangerModal';
import type { ConnectedSite } from '../../lib/connected-sites.core';
import { BiometricSettingsCard } from '../BiometricSettingsCard';

interface AccountInfo {
  id: string;
  label: string;
  address: string;
  type: AccountType;
  source: AccountSource;
  derivationPath?: string;
}

const LOCK_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 240, label: '4 hours' },
  { value: 480, label: '8 hours' },
  { value: 1440, label: '24 hours' },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<WalletSettings | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  // Export private key state
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [exportAccountId, setExportAccountId] = useState<string | null>(null);
  const [exportPassword, setExportPassword] = useState('');
  const [exportedKey, setExportedKey] = useState('');
  const [exportError, setExportError] = useState('');
  const [exportRevealed, setExportRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sites, setSites] = useState<ConnectedSite[]>([]);
  const [sitesError, setSitesError] = useState('');

  useEffect(() => {
    callBackground<WalletSettings>('getSettings').then(setSettings);
    callBackground<AccountInfo[]>('listAccounts').then(setAccounts);
    callBackground<ConnectedSite[]>('getConnectedSites').then(setSites);
  }, []);

  async function disconnect(origin: string) {
    setSitesError('');
    try {
      await callBackground('disconnectSite', { origin });
    } catch (e: any) {
      console.error('[Auto-Wallet] Failed to disconnect site:', e);
      setSitesError(e.message);
      return;
    }
    setSites(await callBackground<ConnectedSite[]>('getConnectedSites'));
  }

  async function updateSetting(patch: Partial<WalletSettings>) {
    const updated = await callBackground<WalletSettings>('saveSettings', patch);
    setSettings(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function handleExport() {
    if (!exportAccountId || !exportPassword) { setExportError('Password is required'); return; }
    setExportError('');
    try {
      const key = await callBackground<string>('exportPrivateKey', {
        accountId: exportAccountId,
        password: exportPassword,
      });
      setExportedKey(key);
      setExportPassword('');
      setExportRevealed(false);
    } catch (e: any) {
      setExportError('Wrong password');
    }
  }

  function closeExport() {
    setExportAccountId(null);
    setExportPassword('');
    setExportedKey('');
    setExportError('');
    setExportRevealed(false);
    setCopied(false);
  }

  async function copyKey() {
    await navigator.clipboard.writeText(exportedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function executeDeleteAll() {
    await callBackground('deleteWallet');
    window.location.reload();
  }

  async function handleDeleteAll() {
    // If any account stores a private key on this device (privateKey or
    // mnemonic source), require the 3-step backup-acknowledgement flow.
    // If the wallet only has Ledger / watch-only accounts, the legacy
    // inline two-click confirm is sufficient.
    const hasSigningKey = accounts.some(
      (a) => a.source === 'privateKey' || a.source === 'mnemonic',
    );
    if (hasSigningKey) {
      setDangerOpen(true);
      return;
    }
    if (!deleteConfirm) { setDeleteConfirm(true); return; }
    await executeDeleteAll();
  }

  if (!settings) {
    return <div className="loading-page"><div className="spinner" /></div>;
  }

  const exportAccount = accounts.find((a) => a.id === exportAccountId);
  const exportableAccounts = accounts.filter((a) => a.type === 'private');

  return (
    <div className="stack stack-md animate-in">
      <div className="row row-between">
        <p className="page-title">Settings</p>
        {saved && <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 500 }}>Saved</span>}
      </div>

      {/* Appearance */}
      <div className="card">
        <p className="section-label" style={{ marginBottom: 10 }}>Appearance</p>
        <div className="theme-toggle">
          {([
            { value: 'auto' as const,  label: 'Auto',  Icon: MonitorIcon },
            { value: 'light' as const, label: 'Light', Icon: SunIcon },
            { value: 'dark' as const,  label: 'Dark',  Icon: MoonIcon },
          ]).map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => updateSetting({ theme: value })}
              className={`theme-option ${settings.theme === value ? 'active' : ''}`}
              aria-pressed={settings.theme === value}
            >
              <span className="theme-option-icon"><Icon size={16} /></span>
              {label}
            </button>
          ))}
        </div>
      </div>

      <BiometricSettingsCard />

      {/* Auto-lock */}
      <div className="card">
        <p className="section-label" style={{ marginBottom: 10 }}>Auto Lock</p>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
          Lock the wallet after a period of inactivity
        </p>
        <div className="settings-grid">
          {LOCK_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateSetting({ autoLockMinutes: opt.value })}
              className={`settings-option ${settings.autoLockMinutes === opt.value ? 'active' : ''}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Export Private Key */}
      <div className="card">
        <p className="section-label" style={{ marginBottom: 10 }}>Export Private Key</p>

        {!exportAccountId ? (
          /* Account selector */
          <div className="stack stack-xs">
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
              Select an account to export
            </p>
            {exportableAccounts.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                No private-key accounts available.
              </p>
            ) : (
              exportableAccounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setExportAccountId(a.id)}
                  className="export-account-btn"
                >
                  <span>{a.label}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {a.address.slice(0, 8)}...{a.address.slice(-6)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : !exportedKey ? (
          /* Password verification */
          <div className="stack stack-sm">
            <div className="row row-between">
              <p style={{ fontSize: 12, fontWeight: 500 }}>{exportAccount?.label}</p>
              <button onClick={closeExport} className="btn-ghost">Cancel</button>
            </div>

            <div className="export-warning">
              Never share your private key. Anyone with it has full control of your account.
            </div>

            <input
              type="password"
              className="input-field"
              placeholder="Enter password to reveal"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleExport()}
              style={{ fontFamily: 'var(--font-sans)' }}
            />
            {exportError && <p className="error-text">{exportError}</p>}
            <button onClick={handleExport} className="btn-primary">Verify & Export</button>
          </div>
        ) : (
          /* Revealed key */
          <div className="stack stack-sm">
            <div className="row row-between">
              <p style={{ fontSize: 12, fontWeight: 500 }}>{exportAccount?.label}</p>
              <button onClick={closeExport} className="btn-ghost">Done</button>
            </div>

            <div className="export-warning">
              Store this securely. It will not be shown again after you close this panel.
            </div>

            <div className="export-key-box" onClick={() => setExportRevealed(true)}>
              {exportRevealed ? (
                <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', lineHeight: 1.6 }}>
                  {exportedKey}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Click to reveal
                </span>
              )}
            </div>

            {exportRevealed && (
              <button onClick={copyKey} className="btn-secondary">
                {copied ? 'Copied!' : 'Copy to Clipboard'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Provider */}
      <div className="card">
        <p className="section-label" style={{ marginBottom: 10 }}>Wallet Display</p>

        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>USD prices</p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Fetch native and ERC-20 prices from CoinGecko (cached 60 min)
            </p>
          </div>
          <button
            onClick={() => updateSetting({ enablePrices: !settings.enablePrices })}
            className={`toggle ${settings.enablePrices ? 'on' : ''}`}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <div className="settings-divider" />

        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>Show nonce</p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Display latest and pending nonce on the Wallet page
            </p>
          </div>
          <button
            onClick={() => updateSetting({ showWalletNonce: !settings.showWalletNonce })}
            className={`toggle ${settings.showWalletNonce ? 'on' : ''}`}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      {/* Provider */}
      <div className="card">
        <p className="section-label" style={{ marginBottom: 10 }}>Provider Injection</p>

        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>EIP-6963 Discovery</p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Announces wallet to dApps via standard protocol
            </p>
          </div>
          <span className="badge badge-on">Always On</span>
        </div>

        <div className="settings-divider" />

        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>Force window.ethereum</p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Always inject even when other wallets exist
            </p>
          </div>
          <button
            onClick={() => updateSetting({ injectWindowEthereum: !settings.injectWindowEthereum })}
            className={`toggle ${settings.injectWindowEthereum ? 'on' : ''}`}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      {/* Connected sites */}
      <div className="card">
        <p className="section-label" style={{ marginBottom: 10 }}>Connected Sites</p>
        {sites.length === 0 ? (
          <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>No site can see your address.</p>
        ) : (
          sites.map((site, i) => (
            <React.Fragment key={site.origin}>
              {i > 0 && <div className="settings-divider" />}
              <div className="settings-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p className="truncate mono" style={{ fontSize: 12, color: 'var(--text-primary)' }} title={site.origin}>
                    {site.origin.replace(/^https:\/\//, '')}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    since {new Date(site.connectedAt).toLocaleDateString()}
                  </p>
                </div>
                <button onClick={() => disconnect(site.origin)} className="btn-ghost danger">
                  Disconnect
                </button>
              </div>
            </React.Fragment>
          ))
        )}
        {sitesError && <p className="error-text">{sitesError}</p>}
      </div>

      {/* Encryption info */}
      <div className="card">
        <p className="section-label" style={{ marginBottom: 8 }}>Encryption</p>
        <div className="rule-detail">
          <div>cipher: AES-256-GCM</div>
          <div>key derivation: PBKDF2 (600k iterations)</div>
          <div>password: shared across all accounts</div>
        </div>
      </div>

      {/* Danger */}
      <div className="card card-danger">
        <p className="section-label" style={{ marginBottom: 8, color: 'var(--danger)' }}>Danger Zone</p>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          Permanently delete all accounts and settings.
        </p>
        <div className="row gap-sm">
          <button onClick={handleDeleteAll} className="btn-danger">
            {deleteConfirm ? 'Yes, Delete Everything' : 'Delete All Accounts'}
          </button>
          {deleteConfirm && (
            <button onClick={() => setDeleteConfirm(false)} className="btn-ghost">Cancel</button>
          )}
        </div>
      </div>

      <DeleteDangerModal
        open={dangerOpen}
        title="Delete all accounts?"
        subject="every account in this wallet"
        destructiveLabel="Delete everything"
        plural
        onCancel={() => setDangerOpen(false)}
        onConfirm={() => { setDangerOpen(false); void executeDeleteAll(); }}
      />

      <div className="social-links">
        <a
          href="https://auto-wallet.nannan.app"
          target="_blank"
          rel="noopener noreferrer"
          className="social-link"
          title="Website"
          aria-label="Website"
        >
          <GlobeIcon size={16} />
        </a>
        <a
          href="https://x.com/lolieatapple"
          target="_blank"
          rel="noopener noreferrer"
          className="social-link"
          title="X (Twitter)"
          aria-label="X (Twitter)"
        >
          <XIcon size={14} />
        </a>
        <a
          href="https://github.com/Auto-Wallet/auto-wallet"
          target="_blank"
          rel="noopener noreferrer"
          className="social-link"
          title="GitHub"
          aria-label="GitHub"
        >
          <GithubIcon size={16} />
        </a>
      </div>
    </div>
  );
}
