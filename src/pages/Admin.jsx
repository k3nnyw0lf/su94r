import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { isAdminUser } from '../lib/access';
import {
  SECRET_REGISTRY, SERVER_ONLY, loadSecrets, saveSecret, maskSecret,
} from '../lib/secrets';

/** One key row. Values stay masked until explicitly revealed. */
function SecretRow({ item, value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSet = !!value;

  const commit = async () => {
    setBusy(true);
    try {
      await onSave(item.key, draft);
      setEditing(false);
      setDraft('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-row">
      <div className="admin-row-head">
        <div>
          <div className="admin-key-label">{item.label}</div>
          <div className="admin-key-hint">{item.hint}</div>
        </div>
        <span className={`admin-pill ${isSet ? 'set' : 'unset'}`}>
          {isSet ? 'SET' : 'NOT SET'}
        </span>
      </div>

      {editing ? (
        <div className="admin-edit">
          <input
            className="settings-input"
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={isSet ? 'New value (leave blank to remove)' : 'Paste key…'}
            autoComplete="off"
            spellCheck="false"
          />
          <div className="admin-edit-actions">
            <button className="fit-btn-ghost" onClick={() => { setEditing(false); setDraft(''); }} disabled={busy}>
              Cancel
            </button>
            <button className="fit-btn" onClick={commit} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="admin-value-row">
          <code className="admin-value">
            {isSet ? (reveal ? value : maskSecret(value)) : '—'}
          </code>
          <div className="admin-edit-actions">
            {isSet && (
              <button className="fit-btn-ghost" onClick={() => setReveal(r => !r)}>
                {reveal ? 'Hide' : 'Reveal'}
              </button>
            )}
            <button className="fit-btn-ghost" onClick={() => setEditing(true)}>
              {isSet ? 'Change' : 'Add'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Admin({ user, onShowAuth }) {
  const [secrets, setSecrets] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const admin = isAdminUser(user);

  useEffect(() => {
    if (!admin) { setLoading(false); return; }
    let alive = true;
    loadSecrets()
      .then(s => { if (alive) { setSecrets(s); setError(null); } })
      .catch(e => { if (alive) setError(e.message || 'Could not load keys'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [admin]);

  const handleSave = async (key, value) => {
    try {
      const res = await saveSecret(key, value, user?.email);
      setSecrets(prev => {
        const next = { ...prev };
        if (res.deleted) delete next[key];
        else next[key] = value.trim();
        return next;
      });
      toast.success(res.deleted ? 'Key removed' : 'Key saved');
    } catch (e) {
      // Surface the real reason. A silent failure here looks identical to
      // success and the admin would assume the key is live when it is not.
      toast.error(e.message || 'Save failed');
      throw e;
    }
  };

  if (!user) {
    return (
      <div className="page fade-up">
        <div className="page-header"><h1>Admin</h1></div>
        <div className="info-card">Sign in to continue.</div>
        <button className="fit-btn fit-btn-lg" onClick={onShowAuth}>Sign in</button>
      </div>
    );
  }

  if (!admin) {
    return (
      <div className="page fade-up">
        <div className="page-header"><h1>Admin</h1></div>
        <div className="fit-gate fit-gate-block">
          <div className="fit-gate-title">Not an admin account</div>
          <div className="fit-gate-detail">
            You are signed in as {user.email}. The admin panel is restricted.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page fade-up">
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <div className="page-subtitle">{user.email}</div>
        </div>
      </div>

      <div className="info-card">
        These keys sync across your devices and are readable only by admin accounts.
        They are used by the browser directly, so treat them as visible to anyone
        with access to a signed-in admin session — rotate them if a device is lost.
      </div>

      {loading && <div className="info-card">Loading keys…</div>}

      {error && (
        <div className="fit-gate fit-gate-block">
          <div className="fit-gate-title">Could not load keys</div>
          <div className="fit-gate-detail">{error}</div>
        </div>
      )}

      {!loading && !error && SECRET_REGISTRY.map(group => (
        <div key={group.group}>
          <div className="device-section-title">{group.group}</div>
          {group.items.map(item => (
            <SecretRow
              key={item.key}
              item={item}
              value={secrets[item.key]}
              onSave={handleSave}
            />
          ))}
        </div>
      ))}

      <div className="device-section-title">Not stored here</div>
      <div className="info-card">
        These are deliberately excluded. A key the browser never sees cannot be
        stolen from the browser.
      </div>
      {SERVER_ONLY.map(s => (
        <div key={s.name} className="admin-row admin-row-locked">
          <div className="admin-key-label">{s.name}</div>
          <div className="admin-key-hint">{s.where}</div>
        </div>
      ))}

      <div style={{ height: 16 }} />
    </div>
  );
}
