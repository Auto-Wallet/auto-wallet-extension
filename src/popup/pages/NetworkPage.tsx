import React, { useState, useEffect, useMemo } from 'react';
import { callBackground } from '../api';
import type { Network } from '../../types/network';
import { SearchIcon, CloseIcon, StarIcon } from '../icons';

export function NetworkPage() {
  const [networks, setNetworks] = useState<Network[]>([]);
  const [active, setActive] = useState<number>(1);
  const [showForm, setShowForm] = useState(false);
  const [editingNetwork, setEditingNetwork] = useState<Network | null>(null);
  const [search, setSearch] = useState('');
  const [confirmDeleteChainId, setConfirmDeleteChainId] = useState<number | null>(null);
  const [starred, setStarred] = useState<Set<number>>(new Set());
  const [form, setForm] = useState({ chainId: '', name: '', rpcUrl: '', symbol: '', decimals: '18', blockExplorerUrl: '' });

  useEffect(() => { loadNetworks(); }, []);

  async function loadNetworks() {
    const [nets, act, starredIds] = await Promise.all([
      callBackground<Network[]>('getNetworks'),
      callBackground<Network>('getActiveNetwork'),
      callBackground<number[]>('getStarredNetworks').catch(() => [] as number[]),
    ]);
    setNetworks(nets);
    setActive(act.chainId);
    setStarred(new Set(starredIds ?? []));
  }

  function toggleStar(chainId: number) {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(chainId)) next.delete(chainId);
      else next.add(chainId);
      callBackground('setStarredNetworks', { chainIds: Array.from(next) }).catch(() => {});
      return next;
    });
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? networks.filter((n) =>
          n.name.toLowerCase().includes(q) ||
          n.symbol.toLowerCase().includes(q) ||
          String(n.chainId).includes(q)
        )
      : networks;
    return [...matched].sort((a, b) => {
      const aStar = starred.has(a.chainId) ? 1 : 0;
      const bStar = starred.has(b.chainId) ? 1 : 0;
      if (aStar !== bStar) return bStar - aStar;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [networks, search, starred]);

  const firstUnstarredChainId = useMemo(() => {
    const n = filtered.find((x) => !starred.has(x.chainId));
    return n ? n.chainId : null;
  }, [filtered, starred]);

  async function switchTo(chainId: number) {
    await callBackground('switchNetwork', { chainId });
    setActive(chainId);
  }

  async function saveNetwork() {
    const chainId = parseInt(form.chainId);
    if (!chainId || !form.name || !form.rpcUrl || !form.symbol) return;
    const payload: Network = {
      chainId,
      name: form.name,
      rpcUrl: form.rpcUrl,
      symbol: form.symbol,
      decimals: parseInt(form.decimals) || 18,
      blockExplorerUrl: form.blockExplorerUrl || undefined,
      isCustom: true,
    };
    const action = editingNetwork ? 'updateNetwork' : 'addCustomNetwork';
    await callBackground(action, payload);
    setForm({ chainId: '', name: '', rpcUrl: '', symbol: '', decimals: '18', blockExplorerUrl: '' });
    setShowForm(false);
    setEditingNetwork(null);
    loadNetworks();
  }

  function openAddForm() {
    setEditingNetwork(null);
    setForm({ chainId: '', name: '', rpcUrl: '', symbol: '', decimals: '18', blockExplorerUrl: '' });
    setShowForm(true);
  }

  function openEditForm(network: Network) {
    setEditingNetwork(network);
    setForm({
      chainId: String(network.chainId),
      name: network.name,
      rpcUrl: network.rpcUrl,
      symbol: network.symbol,
      decimals: String(network.decimals),
      blockExplorerUrl: network.blockExplorerUrl ?? '',
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingNetwork(null);
    setForm({ chainId: '', name: '', rpcUrl: '', symbol: '', decimals: '18', blockExplorerUrl: '' });
  }

  async function removeNetwork(chainId: number) {
    if (confirmDeleteChainId !== chainId) {
      setConfirmDeleteChainId(chainId);
      return;
    }
    await callBackground('removeCustomNetwork', { chainId });
    setConfirmDeleteChainId(null);
    loadNetworks();
  }

  return (
    <div className="stack stack-sm animate-in">
      <div className="row row-between">
        <p className="page-title">Networks</p>
        <button onClick={showForm ? closeForm : openAddForm} className="btn-ghost accent">
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {/* Search */}
      <div className="search-box">
        <SearchIcon size={14} className="search-icon" />
        <input
          className="search-input"
          placeholder="Search by name, symbol, or chain ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button onClick={() => setSearch('')} className="search-clear" aria-label="Clear search">
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {/* Add/edit form */}
      {showForm && (
        <div className="card-form">
          <div className="row row-between">
            <p className="section-label">{editingNetwork ? 'Edit Network' : 'Add Network'}</p>
          </div>
          <div className="grid-2">
            <input className="input-field" placeholder="Chain ID" value={form.chainId} onChange={(e) => setForm({ ...form, chainId: e.target.value })} disabled={!!editingNetwork} />
            <input className="input-field" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ fontFamily: 'var(--font-sans)' }} />
          </div>
          <input className="input-field" placeholder="RPC URL" value={form.rpcUrl} onChange={(e) => setForm({ ...form, rpcUrl: e.target.value })} />
          <div className="grid-2">
            <input className="input-field" placeholder="Symbol" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} />
            <input className="input-field" placeholder="Decimals" value={form.decimals} onChange={(e) => setForm({ ...form, decimals: e.target.value })} />
          </div>
          <input className="input-field" placeholder="Block explorer URL (optional)" value={form.blockExplorerUrl} onChange={(e) => setForm({ ...form, blockExplorerUrl: e.target.value })} />
          <button onClick={saveNetwork} className="btn-primary">
            {editingNetwork ? 'Save Network' : 'Add Network'}
          </button>
        </div>
      )}

      {/* Results */}
      {search && (
        <p className="section-label">
          {filtered.length} result{filtered.length !== 1 ? 's' : ''}
        </p>
      )}

      {filtered.length === 0 && (
        <div className="empty-state">
          {search ? `No networks matching "${search}"` : 'No networks'}
        </div>
      )}

      {!search && starred.size > 0 && filtered.some((n) => starred.has(n.chainId)) && (
        <div className="row gap-xs section-label">
          <StarIcon size={9} /> Pinned
        </div>
      )}

      {filtered.map((n) => {
        const isStarred = starred.has(n.chainId);
        const isActive = n.chainId === active;
        const showAzDivider = !search && starred.size > 0 && n.chainId === firstUnstarredChainId;
        const isConfirmingDelete = confirmDeleteChainId === n.chainId;
        return (
          <React.Fragment key={n.chainId}>
            {showAzDivider && (
              <div className="section-label" style={{ marginTop: 4 }}>All Chains</div>
            )}
            <div
              className={`card card-clickable network-card ${isActive ? 'card-active network-card-active' : ''}`}
              onClick={() => switchTo(n.chainId)}
            >
              <div className="row row-between">
                <div className="row gap-sm" style={{ minWidth: 0, flex: 1 }}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleStar(n.chainId); }}
                    className={`network-star-btn ${isStarred ? 'is-starred' : ''}`}
                    aria-label={isStarred ? 'Unpin chain' : 'Pin chain to top'}
                    title={isStarred ? 'Unpin chain' : 'Pin chain to top'}
                  >
                    <StarIcon size={12} />
                  </button>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: isActive ? 600 : 500 }}>{n.name}</div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      Chain {n.chainId} &middot; {n.symbol}
                    </div>
                  </div>
                </div>
                <div className="row gap-sm">
                  {isActive && <span className="pulse-dot" />}
                  <button onClick={(e) => { e.stopPropagation(); openEditForm(n); }} className="btn-ghost accent">Edit</button>
                  {isConfirmingDelete ? (
                    <span className="row gap-xs">
                      <button
                        onClick={(e) => { e.stopPropagation(); removeNetwork(n.chainId); }}
                        className="btn-ghost danger"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteChainId(null); }}
                        className="btn-ghost"
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeNetwork(n.chainId); }}
                      className="btn-ghost danger"
                    >
                      Del
                    </button>
                  )}
                </div>
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
