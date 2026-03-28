import React, { useState } from 'react';
import { useHealthStore } from '../store/healthStore';

const SECTIONS = [
  {
    title: 'CGM Sensors',
    devices: [
      { name: 'FreeStyle Libre 3+', badge: 'CONNECT NOW', cls: 'badge-best', sub: '15-day wear · Real-time · 1-min readings · No fingersticks', note: 'Connect via LibreLinkUp API. Enable LibreLinkUp sharing in the LibreLink app first.', tags: ['Real-time', '15-day', 'No calibration', 'iOS & Android'], howto: 'Settings → CGM → Libre → enter email + password', configKey: 'libreEmail', settingsTab: 'cgm' },
      { name: 'Dexcom G7', badge: 'CONNECT NOW', cls: 'badge-top', sub: '10-15 day wear · 5-min readings · Best accuracy', note: 'Connect via Dexcom Share API. Enable Share in the Dexcom app.', tags: ['Dexcom Share', '10-15 days', 'Apple Watch', 'Omnipod 5'], howto: 'Settings → CGM → Dexcom → enter credentials + region', configKey: 'dexcomUser', settingsTab: 'cgm' },
      { name: 'Nightscout (Any CGM)', badge: 'UNIVERSAL', cls: 'badge-best', sub: 'Self-hosted · Works with any CGM → Nightscout bridge', note: 'Add your URL and optional API secret. Works with Loop, AndroidAPS, OpenAPS.', tags: ['Self-hosted', 'Open source', 'Any pump', 'Full history'], howto: 'Settings → CGM → Nightscout → add URL + token', configKey: 'nightscoutUrl', settingsTab: 'cgm' },
      { name: 'Dexcom Stelo / Rio', badge: 'OTC', cls: 'badge-coming', sub: 'Over-the-counter · No prescription · 15-day', note: 'FDA-cleared OTC CGM. Connect via Dexcom Share API (same as G7).', tags: ['No prescription', 'OTC', '15-day', 'Dexcom Share'], configKey: 'dexcomUser', settingsTab: 'cgm' },
    ]
  },
  {
    title: 'Insulin Pumps & AID Systems',
    devices: [
      { name: 'Omnipod 5', badge: 'BEST CHOICE', cls: 'badge-top', sub: 'Tubeless · SmartAdjust every 5min · Dexcom G6/G7', note: 'Tubeless AID system. Connect via Nightscout + Loop.', tags: ['Tubeless', 'No screen', 'Dexcom G6/G7', 'AID'], howto: 'Omnipod → Loop/AndroidAPS → Nightscout → su94r' },
      { name: 'Tandem t:slim X2 + Control-IQ+', badge: 'BEST ALGORITHM', cls: 'badge-best', sub: 'Control-IQ+ · Dexcom G6/G7/Libre 3+ · 7-day infusion set', note: 'Most advanced algorithm. Compatible with Libre 3+.', tags: ['Control-IQ+', 'Libre 3+ compatible', 'Touchscreen', 'Tubed'], howto: 'Tandem Source → Nightscout → su94r' },
      { name: 'Tandem Mobi', badge: 'SMALLEST', cls: 'badge-best', sub: '50% smaller · 100% phone-controlled · Control-IQ+', note: 'Smallest tubed pump. Fully phone-controlled.', tags: ['Pocket-size', 'Phone control', 'Control-IQ+', 'Android 2026'], howto: 'Tandem Source → Nightscout → su94r' },
      { name: 'Medtronic MiniMed 780G', badge: 'MOST POPULAR', cls: 'badge-best', sub: 'SmartGuard · Meal Detection · Guardian 4/Instinct sensor', note: 'Global market leader, 700k+ users.', tags: ['700k+ users', 'Meal detection', 'SmartGuard', 'Global'], howto: 'CareLink → Nightscout → su94r' },
      { name: 'Beta Bionics iLet', badge: 'MOST AUTOMATED', cls: 'badge-top', sub: 'No carb counting · Dexcom G6/G7/Libre 3+ · Weight-based dosing', note: 'Just say Small/Medium/Large for meals. Most hands-off pump.', tags: ['No carb counting', 'Libre 3+', 'Weight-based', 'Automated'], howto: 'iLet app data → Nightscout → su94r' },
    ]
  },
  {
    title: 'Wearables & Health Devices',
    devices: [
      { name: 'Apple Watch / iPhone', badge: 'IOS SHORTCUT', cls: 'badge-best', sub: 'Heart rate, HRV, sleep, steps, SpO2 via Apple Health', note: 'Use the Apple Shortcut to send data to su94r automatically.', tags: ['Heart rate', 'HRV', 'Sleep', 'Steps', 'SpO2'], howto: 'Download shortcut → add automation → every 15 min' },
      { name: 'Oura Ring', badge: 'FREE API', cls: 'badge-top', sub: 'Sleep stages, HRV, readiness, temperature', note: 'Best sleep and HRV tracking. Free API with your ring.', tags: ['Sleep stages', 'HRV', 'Temperature', 'Readiness score'], configKey: 'ouraToken', settingsTab: 'fitness' },
      { name: 'Fitbit', badge: 'FREE API', cls: 'badge-best', sub: 'Steps, HR, sleep, weight, calories', note: 'Free API with your device.', tags: ['Steps', 'Sleep', 'HR zones', 'Weight'], configKey: 'fitbitToken', settingsTab: 'fitness' },
      { name: 'Garmin', badge: 'FREE API', cls: 'badge-best', sub: 'All Garmin data — apply for API access', note: 'Comprehensive data. Apply at developer.garmin.com.', tags: ['All metrics', 'Apply required', 'Comprehensive', 'HRV'], configKey: 'garminToken', settingsTab: 'fitness' },
      { name: 'Withings', badge: 'FREE API', cls: 'badge-best', sub: 'Blood pressure, weight, sleep mat, thermometer', note: 'Best non-invasive BP monitoring. Free API.', tags: ['Blood pressure', 'Weight', 'Sleep mat', 'Temperature'], configKey: 'withingsToken', settingsTab: 'fitness' },
      { name: 'Whoop', badge: 'API AVAILABLE', cls: 'badge-coming', sub: 'Strain, recovery, HRV, sleep — subscription required', note: 'Recovery and strain data correlate with glucose management.', tags: ['Recovery score', 'Strain', 'HRV', 'Sleep'] },
    ]
  },
  {
    title: 'Coming Soon (2026-2027)',
    devices: [
      { name: 'Niia (PharmaSens)', badge: 'COMING', cls: 'badge-coming', sub: 'First pump + CGM combined patch — screenless, app-controlled', note: 'One patch = CGM and insulin pump combined. CE Mark pending.', tags: ['All-in-one', 'Patch', 'Screenless', 'Europe first'] },
      { name: 'Continuous Ketone Monitor', badge: 'COMING 2026', cls: 'badge-coming', sub: 'First CGM measuring both glucose AND ketones in real-time', note: 'Will revolutionize DKA prevention. su94r will integrate on launch.', tags: ['Glucose + Ketones', 'DKA prevention', 'Real-time', 'FDA pending'] },
      { name: 'Omnipod 8-Series', badge: 'COMING', cls: 'badge-coming', sub: 'Next-gen pod · 300 units · Better algorithm', note: '50% more insulin capacity. Expected 2026-2027.', tags: ['300 units', 'New algorithm', 'Trials 2025'] },
    ]
  },
];

export default function Devices() {
  const [search, setSearch] = useState('');
  const { settings } = useHealthStore();

  const isConnected = (configKey) => {
    if (!configKey) return false;
    return !!settings[configKey];
  };

  const filtered = SECTIONS.map(s => ({
    ...s,
    devices: s.devices.filter(d =>
      !search || d.name.toLowerCase().includes(search.toLowerCase()) || d.note.toLowerCase().includes(search.toLowerCase()) || d.tags.some(t => t.toLowerCase().includes(search.toLowerCase()))
    )
  })).filter(s => s.devices.length > 0);

  const connectedCount = SECTIONS.flatMap(s => s.devices).filter(d => isConnected(d.configKey)).length;

  return (
    <div className="page fade-up">
      <div className="page-header">
        <div>
          <h1>Devices</h1>
          {connectedCount > 0 && (
            <div className="page-subtitle" style={{ color: 'var(--green)' }}>{connectedCount} CONNECTED</div>
          )}
        </div>
        <div className="page-subtitle">2026 GUIDE</div>
      </div>

      <div className="info-card">
        All connections stay on your device. su94r never shares your credentials. Always consult your endocrinologist before switching devices.
      </div>

      {/* Search */}
      <input
        className="device-search"
        placeholder="Search devices, tags..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {filtered.map(section => (
        <div key={section.title}>
          <div className="device-section-title">{section.title}</div>
          {section.devices.map((d, i) => {
            const connected = isConnected(d.configKey);
            return (
              <div key={i} className={`device-card ${connected ? 'device-connected' : ''}`}>
                <div className="device-top">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {connected && <span className="device-status-dot" />}
                    <div className="device-name">{d.name}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {connected && <span className="device-badge badge-connected">CONNECTED</span>}
                    {d.badge && <span className={`device-badge ${d.cls}`}>{d.badge}</span>}
                  </div>
                </div>
                <div className="device-sub">{d.sub}</div>
                <div className="device-note">{d.note}</div>
                {d.howto && (
                  <div className="device-howto">
                    ▶ {d.howto}
                  </div>
                )}
                <div className="device-tags">{d.tags.map((t, j) => <span key={j} className="device-tag">{t}</span>)}</div>
              </div>
            );
          })}
        </div>
      ))}

      <div style={{ height: 16 }} />
    </div>
  );
}
