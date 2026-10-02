import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { supabase } from '../lib/supabase';
import { resolveTimeZone } from '../lib/util/localDay';
import { ESCALATION_LIMITS } from '../lib/care/escalation';

/**
 * Settings for the overnight glucose monitor.
 *
 * WHAT IS EDITABLE HERE AND WHAT IS NOT
 *
 * Everything on this screen is BEHAVIOUR: when to escalate, to whom, which
 * lights. None of it is a credential, which is why it can live in a database
 * the browser reaches.
 *
 * The tokens — Supabase service key, Home Assistant token, Twilio — are
 * Cloudflare Worker secrets. Each of them, in a browser, is a full compromise:
 * the service key bypasses RLS on every table in the project, and the HA token
 * controls a house. The panel says so plainly rather than leaving a gap the
 * user assumes is a bug.
 */

const DEFAULTS = {
  enabled: false,
  time_zone: resolveTimeZone(),
  patient_name: '',
  low_mgdl: 70,
  severe_mgdl: 55,
  night_start_hour: 22,
  night_end_hour: 8,
  self_ack_minutes: 8,
  care_push_minutes: 6,
  care_sms_minutes: 5,
  home_config: {},
};

/** Common zones first; the browser's own guess is always offered. */
const ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Madrid', 'Europe/Berlin', 'UTC',
];

const entityList = v =>
  String(v || '').split(',').map(s => s.trim()).filter(Boolean);

function ZoneDevices({ label, hint, zone, value, onChange }) {
  const set = (field, raw) => onChange({ ...value, [field]: entityList(raw) });
  const get = field => (value?.[field] || []).join(', ');

  return (
    <div className="admin-row">
      <div className="admin-key-label">{label}</div>
      <div className="admin-key-hint">{hint}</div>
      {[
        ['lights', 'Lights', 'light.bedroom, light.lamp'],
        ['speakers', 'Speakers', 'media_player.echo_bedroom'],
        ...(zone === 'helpers'
          ? [['sirens', 'Sirens', 'switch.hall_siren'], ['tvs', 'TVs', 'media_player.living_room_tv']]
          : []),
      ].map(([field, fieldLabel, placeholder]) => (
        <label key={field} className="log-field" style={{ marginTop: 8 }}>
          <span>{fieldLabel}</span>
          <input
            className="settings-input"
            value={get(field)}
            placeholder={placeholder}
            onChange={e => set(field, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

export default function MonitorSettings({ user }) {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user?.email) { setLoading(false); return; }
    let alive = true;
    supabase
      .from('su94r_monitor_config')
      .select('*')
      .eq('patient_email', user.email)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err) setError(err.message);
        setCfg({ ...DEFAULTS, patient_name: user.email.split('@')[0], ...(data || {}) });
        setLoading(false);
      });
    return () => { alive = false; };
  }, [user?.email]);

  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));
  const num = (k, v) => set(k, v === '' ? '' : Number(v));

  const save = async () => {
    setSaving(true);
    try {
      // The database enforces these too (severe < low, sane ranges). Checking
      // here as well turns a raw constraint error into a sentence.
      if (cfg.severe_mgdl >= cfg.low_mgdl) {
        throw new Error('Severe threshold must be below the low threshold.');
      }
      const { error: err } = await supabase
        .from('su94r_monitor_config')
        .upsert({ ...cfg, patient_email: user.email, updated_at: new Date().toISOString() });
      if (err) throw new Error(err.message);
      toast.success('Monitor settings saved — live within 5 minutes');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!user) return <div className="info-card">Sign in to configure the overnight monitor.</div>;
  if (loading) return <div className="info-card">Loading monitor settings…</div>;
  if (error) return <div className="fit-gate fit-gate-block"><div className="fit-gate-detail">{error}</div></div>;

  const zones = [...new Set([resolveTimeZone(), ...ZONES])];

  return (
    <>
      <div className={`fit-gate ${cfg.enabled ? 'fit-gate-clear' : 'fit-gate-unknown'}`}>
        <div className="fit-gate-title">
          Overnight monitoring is {cfg.enabled ? 'on' : 'off'}
        </div>
        <div className="fit-gate-detail">
          Checks your glucose every 5 minutes from the server, whether or not your
          phone is awake. Escalates if you do not respond to a low.
        </div>
        <button className="fit-btn" onClick={() => set('enabled', !cfg.enabled)}>
          {cfg.enabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      <div className="device-section-title">Basics</div>

      <label className="log-field">
        <span>Your timezone — a wrong value inverts the night window</span>
        <select className="settings-input" value={cfg.time_zone} onChange={e => set('time_zone', e.target.value)}>
          {zones.map(z => <option key={z} value={z}>{z}</option>)}
        </select>
      </label>

      <label className="log-field">
        <span>Name spoken aloud in alerts</span>
        <input
          className="settings-input" value={cfg.patient_name || ''}
          onChange={e => set('patient_name', e.target.value)} placeholder="Sam"
        />
      </label>

      <div className="device-section-title">Thresholds</div>
      <div className="log-row">
        <label className="log-field">
          <span>Low (mg/dL)</span>
          <input className="settings-input" type="number" value={cfg.low_mgdl} onChange={e => num('low_mgdl', e.target.value)} />
        </label>
        <label className="log-field">
          <span>Severe — skips the wait</span>
          <input className="settings-input" type="number" value={cfg.severe_mgdl} onChange={e => num('severe_mgdl', e.target.value)} />
        </label>
      </div>

      <div className="log-row">
        <label className="log-field">
          <span>Night starts</span>
          <input className="settings-input" type="number" min="0" max="23" value={cfg.night_start_hour} onChange={e => num('night_start_hour', e.target.value)} />
        </label>
        <label className="log-field">
          <span>Night ends</span>
          <input className="settings-input" type="number" min="0" max="23" value={cfg.night_end_hour} onChange={e => num('night_end_hour', e.target.value)} />
        </label>
      </div>

      <div className="device-section-title">Escalation timing</div>
      <div className="info-card">
        How long each rung waits before the next. A severe low ignores the first
        wait entirely.
      </div>
      <div className="log-row">
        <label className="log-field">
          <span>You respond (min)</span>
          <input className="settings-input" type="number" value={cfg.self_ack_minutes} onChange={e => num('self_ack_minutes', e.target.value)} />
        </label>
        <label className="log-field">
          <span>Then SMS after</span>
          <input className="settings-input" type="number" value={cfg.care_push_minutes} onChange={e => num('care_push_minutes', e.target.value)} />
        </label>
        <label className="log-field">
          <span>Then call after</span>
          <input className="settings-input" type="number" value={cfg.care_sms_minutes} onChange={e => num('care_sms_minutes', e.target.value)} />
        </label>
      </div>

      <div className="device-section-title">Home devices</div>
      <div className="info-card">
        Entity IDs from Home Assistant. These are not secrets — knowing
        <code> light.bedroom</code> grants nothing without the token, which stays
        on the server.
      </div>

      <ZoneDevices
        label="Your room"
        hint="Woken gently first — a lamp at 30% before anything louder."
        zone="patient"
        value={cfg.home_config?.patient}
        onChange={v => set('home_config', { ...cfg.home_config, patient: v })}
      />
      <ZoneDevices
        label="Other rooms"
        hint="A child's room, a partner's room. Untouched until someone actually needs to get up, then loud — and told to come to you."
        zone="helpers"
        value={cfg.home_config?.helpers}
        onChange={v => set('home_config', { ...cfg.home_config, helpers: v })}
      />

      <button className="fit-btn fit-btn-lg" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save monitor settings'}
      </button>

      {/* Stated plainly rather than left as a gap the user reads as a bug. */}
      <div className="device-section-title">Not editable here — and deliberately</div>
      <div className="info-card">
        Four credentials stay on the server as Cloudflare Worker secrets, because
        each one in a browser is a full compromise:
      </div>
      {[
        ['SUPABASE_SERVICE_KEY', 'Bypasses row-level security on every table in the project, including data unrelated to su94r.'],
        ['HEALTH_INGEST_TOKEN', 'Writes health data and triggers the monitor.'],
        ['HA_TOKEN', 'Controls the lights, speakers and locks in your home.'],
        ['TWILIO_TOKEN', 'Sends messages and spends money.'],
      ].map(([name, why]) => (
        <div key={name} className="admin-row admin-row-locked">
          <div className="admin-key-label">{name}</div>
          <div className="admin-key-hint">{why}</div>
        </div>
      ))}
      <div className="info-card">
        Set once with <code>npx wrangler secret put NAME</code> in the workers
        folder. Everything on this page takes effect within five minutes without
        touching them.
      </div>

      <div className="fit-gate fit-gate-caution">
        <div className="fit-gate-detail">{ESCALATION_LIMITS}</div>
      </div>
    </>
  );
}
