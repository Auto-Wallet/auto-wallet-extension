import React, { useMemo, useState, useEffect } from 'react';
import { callBackground } from '../api';
import { AccountBadge } from '../AccountBadge';
import { partitionAccountsForDisplay, type AccountSource, type AccountType } from '../../lib/key-manager.core';
import { DeleteDangerModal } from '../DeleteDangerModal';
import { SettingsIcon } from '../icons';

interface AccountInfo {
  id: string;
  label: string;
  address: string;
  type: AccountType;
  source: AccountSource;
  derivationPath?: string;
}

type AddMode = null | 'create' | 'import-pk' | 'import-mnemonic' | 'import-ledger' | 'watch-only';
type PickedLedgerAccount = { address: string; derivationPath: string; label?: string };

export function AccountMenu({ onSwitch, onClose, onSettings }: { onSwitch: () => void; onClose: () => void; onSettings: () => void }) {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeId, setActiveId] = useState('');
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [label, setLabel] = useState('');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [switchError, setSwitchError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [dangerRemoveAccount, setDangerRemoveAccount] = useState<AccountInfo | null>(null);
  const [accountQuery, setAccountQuery] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    const [accts, aId] = await Promise.all([
      callBackground<AccountInfo[]>('listAccounts'),
      callBackground<string>('getActiveAccountId'),
    ]);
    setAccounts(accts);
    setActiveId(aId);
  }

  async function switchTo(id: string) {
    setSwitchError('');
    try {
      await callBackground('switchAccount', { accountId: id });
    } catch (e: any) {
      // e.g. an account still encrypted under an older password.
      console.error('[Auto-Wallet] Failed to switch account:', e);
      setSwitchError(e.message);
      return;
    }
    onSwitch();
  }

  async function handleAdd() {
    setLoading(true);
    setError('');
    try {
      const lbl = label.trim() || undefined;
      if (addMode === 'create') {
        await callBackground('addAccountGenerate', { label: lbl });
      } else if (addMode === 'import-pk') {
        const pk = input.trim().startsWith('0x') ? input.trim() : `0x${input.trim()}`;
        await callBackground('addAccountPrivateKey', { privateKey: pk, label: lbl });
      } else if (addMode === 'import-mnemonic') {
        await callBackground('addAccountMnemonic', { mnemonic: input.trim(), label: lbl });
      } else if (addMode === 'watch-only') {
        await callBackground('addWatchOnlyAccount', { address: input.trim(), label: lbl });
      }
      setAddMode(null); setLabel(''); setInput('');
      onSwitch(); // refresh parent
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }

  async function handleAddLedger(seeds: PickedLedgerAccount[]) {
    setLoading(true);
    setError('');
    try {
      await callBackground('addLedgerAccounts', { seeds });
      setAddMode(null); setLabel(''); setInput('');
      onSwitch();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }

  async function openLedgerPicker() {
    setLoading(true);
    setError('');
    try {
      const result = await callBackground<{ selected: PickedLedgerAccount[] }>('pickLedgerAccounts');
      await handleAddLedger(result.selected);
    } catch (e: any) {
      if (e.message !== 'Ledger picker was cancelled' && e.message !== 'Ledger picker was closed') {
        setError(e.message);
      }
      setLoading(false);
    }
  }

  async function handleRename(id: string) {
    if (!editLabel.trim()) return;
    await callBackground('renameAccount', { accountId: id, label: editLabel.trim() });
    setEditingId(null); setEditLabel('');
    load();
  }

  /** Hardware-backed (Ledger) and watch-only accounts have no private key on
   *  this device, so the irreversible-key-loss warning does not apply. */
  function isLowRiskRemoval(source: AccountSource) {
    return source === 'ledger' || source === 'watchOnly';
  }

  async function executeRemove(id: string) {
    try {
      await callBackground('removeAccount', { accountId: id });
      setConfirmRemoveId(null);
      setDangerRemoveAccount(null);
      if (id === activeId) onSwitch();
      else load();
    } catch (e: any) { setError(e.message); }
  }

  async function handleRemove(a: AccountInfo) {
    if (isLowRiskRemoval(a.source)) {
      // Keep the existing two-click inline confirm for Ledger / watch-only.
      if (confirmRemoveId !== a.id) {
        setConfirmRemoveId(a.id);
        return;
      }
      await executeRemove(a.id);
      return;
    }
    // Private-key or mnemonic-derived account → open the 3-step danger modal.
    // Clear any stale low-risk "Del → Confirm" state on another row so the
    // UI doesn't keep an orphaned "Confirm" button visible.
    setConfirmRemoveId(null);
    setDangerRemoveAccount(a);
  }

  async function handleCopy(id: string, address: string) {
    await navigator.clipboard.writeText(address);
    setCopiedId(id);
    setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1500);
  }

  async function handleLock() {
    await callBackground('lock');
    window.location.reload();
  }

  const { signerAccounts, watchOnlyAccounts } = useMemo(() => {
    const q = accountQuery.trim().toLowerCase();
    const matches = (a: AccountInfo) => (
      !q ||
      a.label.toLowerCase().includes(q) ||
      a.address.toLowerCase().includes(q) ||
      a.address.toLowerCase().replace(/^0x/, '').startsWith(q.replace(/^0x/, ''))
    );
    const filtered = accounts.filter(matches);
    const { signers, watchOnly } = partitionAccountsForDisplay(filtered);
    return { signerAccounts: signers, watchOnlyAccounts: watchOnly };
  }, [accounts, accountQuery]);

  const hasAnyMatch = signerAccounts.length + watchOnlyAccounts.length > 0;

  function setMode(mode: AddMode) {
    setAddMode(mode);
    setError('');
    if (mode === 'import-ledger') void openLedgerPicker();
  }

  function renderAccountRow(a: AccountInfo) {
    const isWatchOnly = a.type === 'watchOnly';
    return (
      <div
        key={a.id}
        className={`account-menu-item ${a.id === activeId ? 'active' : ''} ${isWatchOnly ? 'watch-only' : ''}`}
      >
        {editingId === a.id ? (
          <div className="row gap-xs" style={{ flex: 1 }}>
            <input className="input-field" style={{ padding: '3px 6px', fontSize: 11, fontFamily: 'var(--font-sans)' }}
              value={editLabel} onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRename(a.id)} autoFocus />
            <button onClick={() => handleRename(a.id)} className="btn-ghost accent" style={{ fontSize: 10 }}>OK</button>
            <button onClick={() => setEditingId(null)} className="btn-ghost" style={{ fontSize: 10 }}>X</button>
          </div>
        ) : (
          <>
            <button className="account-menu-item-main" onClick={() => switchTo(a.id)}>
              <span className="account-menu-item-label">
                <AccountBadge source={a.source} />
                {a.label}
              </span>
              <span className="account-menu-item-addr mono">
                {a.address.slice(0, 6)}...{a.address.slice(-4)}
              </span>
            </button>
            <div className="account-menu-item-actions">
              <button onClick={(e) => { e.stopPropagation(); handleCopy(a.id, a.address); }}
                className="btn-ghost" style={{ fontSize: 9, padding: '2px 4px' }}
                title="Copy address">{copiedId === a.id ? 'Copied' : 'Copy'}</button>
              <button onClick={(e) => { e.stopPropagation(); setEditingId(a.id); setEditLabel(a.label); }}
                className="btn-ghost" style={{ fontSize: 9, padding: '2px 4px' }}>Rename</button>
              {accounts.length > 1 && (
                <button onClick={(e) => { e.stopPropagation(); handleRemove(a); }}
                  className="btn-ghost danger" style={{ fontSize: 9, padding: '2px 4px' }}>
                  {confirmRemoveId === a.id && isLowRiskRemoval(a.source) ? 'Confirm' : 'Del'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="account-menu">
      {/* Account list */}
      <div className="account-menu-section">
        <p className="section-label" style={{ padding: '0 4px', marginBottom: 6 }}>Accounts</p>
        <input
          className="input-field account-menu-search"
          placeholder="Search accounts"
          value={accountQuery}
          onChange={(e) => setAccountQuery(e.target.value)}
        />
        <div className="account-menu-list">
          {signerAccounts.map(renderAccountRow)}
          {watchOnlyAccounts.length > 0 && (
            <div className="account-menu-group-divider">Watch only</div>
          )}
          {watchOnlyAccounts.map(renderAccountRow)}
          {!hasAnyMatch && (
            <p className="account-menu-empty">No matching accounts</p>
          )}
        </div>
        {switchError && <p className="error-text" style={{ padding: '0 4px' }}>{switchError}</p>}
      </div>

      {/* Add account */}
      <div className="account-menu-section">
        {!addMode ? (
          <button onClick={() => setAddMode('create')} className="account-menu-add-btn">
            + Add Account
          </button>
        ) : (
          <div className="stack stack-xs" style={{ padding: 4 }}>
            <div className="row gap-xs" style={{ flexWrap: 'wrap' }}>
              {(['create', 'import-pk', 'import-mnemonic', 'import-ledger', 'watch-only'] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className="account-menu-tab" data-active={addMode === m}>
                  {m === 'create' ? 'New'
                    : m === 'import-pk' ? 'Key'
                    : m === 'import-mnemonic' ? 'Mnemonic'
                    : m === 'import-ledger' ? 'Ledger'
                    : 'Watch'}
                </button>
              ))}
            </div>
            {addMode !== 'import-ledger' && (
              <input className="input-field" placeholder="Name" value={label}
                onChange={(e) => setLabel(e.target.value)}
                style={{ padding: '5px 8px', fontSize: 11, fontFamily: 'var(--font-sans)' }} />
            )}
            {(addMode === 'import-pk' || addMode === 'import-mnemonic') && (
              <textarea className="input-field" style={{ minHeight: 44, padding: '5px 8px', fontSize: 10 }}
                placeholder={addMode === 'import-pk' ? '0x...' : 'word1 word2 ...'}
                value={input} onChange={(e) => setInput(e.target.value)} />
            )}
            {addMode === 'watch-only' && (
              <>
                <input className="input-field" placeholder="0x... address to watch"
                  value={input} onChange={(e) => setInput(e.target.value)}
                  style={{ padding: '5px 8px', fontSize: 11 }} />
                <p style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4, padding: '0 2px' }}>
                  Watch-only addresses can view balances and receive — they cannot sign or send.
                </p>
              </>
            )}
            {error && <p className="error-text">{error}</p>}
            {addMode === 'import-ledger' && (
              <button onClick={openLedgerPicker} disabled={loading} className="btn-primary" style={{ fontSize: 11, padding: '6px 10px' }}>
                {loading ? 'Opening...' : 'Open Ledger Picker'}
              </button>
            )}
            {addMode !== 'import-ledger' && (
              <div className="row gap-xs">
                <button onClick={handleAdd} disabled={loading} className="btn-primary" style={{ fontSize: 11, padding: '6px 10px' }}>
                  {loading ? '...' : 'Add'}
                </button>
                <button onClick={() => { setAddMode(null); setError(''); }} className="btn-ghost" style={{ fontSize: 11 }}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Settings + Lock */}
      <div className="account-menu-section" style={{ borderBottom: 'none', display: 'flex', gap: 8 }}>
        <button onClick={onSettings} className="account-menu-lock-btn" style={{ flex: 1 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <SettingsIcon size={14} /> Settings
          </span>
        </button>
        <button onClick={handleLock} className="account-menu-lock-btn" style={{ flex: 1 }}>
          Lock Wallet
        </button>
      </div>

      <DeleteDangerModal
        open={dangerRemoveAccount !== null}
        title={`Delete "${dangerRemoveAccount?.label ?? ''}"?`}
        subject="this account"
        destructiveLabel="Delete account"
        onCancel={() => setDangerRemoveAccount(null)}
        onConfirm={() => { if (dangerRemoveAccount) void executeRemove(dangerRemoveAccount.id); }}
      />
    </div>
  );
}
