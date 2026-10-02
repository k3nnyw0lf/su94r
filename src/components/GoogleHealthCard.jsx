import React, { useEffect } from 'react';
import toast from 'react-hot-toast';
import { useHealthStore } from '../store/healthStore';
import { PROXY } from '../lib/apis/health';

/**
 * Connect / status card for the Google Health API.
 *
 * The OAuth handshake happens entirely in the Worker — no token, client secret,
 * or ingest credential is ever exposed here. This component only kicks off the
 * redirect and reflects the outcome.
 */

const OUTCOMES = {
  connected: { ok: true, msg: 'Google Health connected' },
  denied: { ok: false, msg: 'You declined the Google permission request' },
  badstate: { ok: false, msg: 'Sign-in expired — try connecting again' },
  notoken: { ok: false, msg: 'Google did not return a refresh token. Revoke su94r at myaccount.google.com and retry.' },
};

export default function GoogleHealthCard() {
  const { settings, updateSettings } = useHealthStore();
  const gh = settings.googleHealth || { connected: false, lastSync: null };

  // The Worker redirects back with ?google=<outcome>. Read it once, surface it,
  // then strip it so a refresh doesn't replay the toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('google');
    if (!outcome) return;

    const result = OUTCOMES[outcome];
    if (result) {
      result.ok ? toast.success(result.msg) : toast.error(result.msg);
      if (result.ok) {
        updateSettings({ googleHealth: { connected: true, lastSync: new Date().toISOString() } });
      }
    }

    params.delete('google');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [updateSettings]);

  const disconnect = () => {
    updateSettings({ googleHealth: { connected: false, lastSync: null } });
    toast('Disconnected here. Also revoke su94r at myaccount.google.com/permissions to fully cut access.');
  };

  return (
    <div className={`device-card ${gh.connected ? 'device-connected' : ''}`}>
      <div className="device-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {gh.connected && <span className="device-status-dot" />}
          <div className="device-name">🤖 Google Health</div>
        </div>
        <span className={`device-badge ${gh.connected ? 'badge-connected' : 'badge-best'}`}>
          {gh.connected ? 'CONNECTED' : 'RECOMMENDED'}
        </span>
      </div>

      <div className="device-sub">Pixel Watch · Fitbit · Android wearables</div>
      <div className="device-note">
        Server-to-server OAuth, so it keeps syncing while your phone is locked — unlike the
        iPhone route, which can’t read Health while the device is locked. Replaces Google Fit
        (deprecated) and the legacy Fitbit Web API (retiring September 2026).
      </div>

      {gh.connected ? (
        <>
          <div className="device-howto">▶ Syncing hourly. Last connected {new Date(gh.lastSync).toLocaleString()}</div>
          <div className="fit-card-actions">
            <button className="fit-btn-ghost" onClick={disconnect}>Disconnect</button>
          </div>
        </>
      ) : (
        <div className="fit-card-actions">
          <button className="fit-btn" onClick={() => { window.location.href = `${PROXY}/google/start`; }}>
            Connect Google Health
          </button>
        </div>
      )}

      <div className="device-tags">
        {['Heart rate', 'HRV', 'Sleep', 'Steps', 'Workouts', 'Sedentary time'].map(t => (
          <span key={t} className="device-tag">{t}</span>
        ))}
      </div>
    </div>
  );
}
