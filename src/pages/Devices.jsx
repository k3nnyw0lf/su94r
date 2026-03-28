import React, { useState } from 'react';

const SECTIONS = [
  {
    title: 'CGM Sensors',
    devices: [
      { name: 'FreeStyle Libre 3+', badge: 'CONNECT NOW', cls: 'badge-best', sub: '15-day wear · Real-time · 1-min readings · No fingersticks', note: 'Connect via LibreLinkUp API — add your LibreLink email and password in Settings → CGM. Enable LibreLinkUp sharing in the LibreLink app first.', tags: ['Real-time', '15-day', 'No calibration', 'iOS & Android'], howto: 'Settings → CGM → Libre → enter email + password' },
      { name: 'Dexcom G7', badge: 'CONNECT NOW', cls: 'badge-top', sub: '10–15 day wear · 5-min readings · Best accuracy', note: 'Connect via Dexcom Share API — add username and password in Settings → CGM. Enable Share in the Dexcom app.', tags: ['Dexcom Share', '10-15 days', 'Apple Watch', 'Omnipod 5'], howto: 'Settings → CGM → Dexcom → enter credentials + region' },
      { name: 'Nightscout (Any CGM)', badge: 'UNIVERSAL', cls: 'badge-best', sub: 'Self-hosted · Works with any CGM → Nightscout bridge', note: 'If you run Nightscout, just add your URL and optional API secret. Works with Loop, AndroidAPS, OpenAPS, and more.', tags: ['Self-hosted', 'Open source', 'Any pump', 'Full history'], howto: 'Settings → CGM → Nightscout → add URL + token' },
      { name: 'Dexcom Stelo / Rio', badge: 'OTC', cls: 'badge-coming', sub: 'Over-the-counter · No prescription · 15-day', note: 'FDA-cleared OTC CGM. No prescription needed. Connect via Dexcom Share API (same as G7). Great starting point.', tags: ['No prescription', 'OTC', '15-day', 'Dexcom Share'], howto: 'Same as Dexcom G7 — Dexcom Share API' },
    ]
  },
  {
    title: 'Insulin Pumps & AID Systems',
    devices: [
      { name: 'Omnipod 5', badge: 'BEST CHOICE', cls: 'badge-top', sub: 'Tubeless · SmartAdjust every 5min · Dexcom G6/G7', note: 'The only tubeless automated insulin delivery (AID) system in the US. No tubes, waterproof pods. Connect via Nightscout + Loop or directly through your Omnipod app data export.', tags: ['Tubeless', 'No screen', 'Dexcom G6/G7', 'AID'], howto: 'Omnipod → Loop/AndroidAPS → Nightscout → su94r' },
      { name: 'Tandem t:slim X2 + Control-IQ+', badge: 'BEST ALGORITHM', cls: 'badge-best', sub: 'Control-IQ+ · Dexcom G6/G7/Libre 3+ · 7-day infusion set', note: 'Most advanced algorithm (launched March 2025). Compatible with Libre 3+. Connect via Nightscout or Tandem Source data export.', tags: ['Control-IQ+', 'Libre 3+ compatible', 'Touchscreen', 'Tubed'], howto: 'Tandem Source → Nightscout → su94r' },
      { name: 'Tandem Mobi', badge: 'SMALLEST', cls: 'badge-best', sub: '50% smaller · 100% phone-controlled · Control-IQ+', note: 'Smallest tubed pump. No buttons — fully controlled from your phone. Android FDA-approved 2026. Connect via Nightscout.', tags: ['Pocket-size', 'Phone control', 'Control-IQ+', 'Android 2026'], howto: 'Tandem Source → Nightscout → su94r' },
      { name: 'Medtronic MiniMed 780G', badge: 'MOST POPULAR', cls: 'badge-best', sub: 'SmartGuard · Meal Detection · Guardian 4/Instinct sensor', note: 'Global market leader, 700k+ users. SmartGuard algorithm adjusts every 5 min. Connect via CareLink uploader → Nightscout.', tags: ['700k+ users', 'Meal detection', 'SmartGuard', 'Global'], howto: 'CareLink → Nightscout → su94r' },
      { name: 'Beta Bionics iLet', badge: 'MOST AUTOMATED', cls: 'badge-top', sub: 'No carb counting · Dexcom G6/G7/Libre 3+ · Weight-based dosing', note: 'Just say Small/Medium/Large for meals. No preset basal rates. Most hands-off pump available. Works with your Libre 3+.', tags: ['No carb counting', 'Libre 3+', 'Weight-based', 'Automated'], howto: 'iLet app data → Nightscout → su94r' },
    ]
  },
  {
    title: 'Wearables & Health Devices',
    devices: [
      { name: 'Apple Watch / iPhone', badge: 'IOS SHORTCUT', cls: 'badge-best', sub: 'Heart rate, HRV, sleep, steps, SpO2 via Apple Health', note: 'Apple Health data can\'t be accessed directly by web apps. Use the Apple Shortcut in the /shortcuts/ folder — runs every 15 min and sends data to su94r automatically.', tags: ['Heart rate', 'HRV', 'Sleep', 'Steps', 'SpO2'], howto: 'Download shortcut from /shortcuts/ → add automation → every 15 min' },
      { name: 'Oura Ring', badge: 'FREE API', cls: 'badge-top', sub: 'Sleep stages, HRV, readiness, temperature', note: 'Best sleep and HRV tracking available. Free API with your ring. Add your API token in Settings → Fitness → Oura.', tags: ['Sleep stages', 'HRV', 'Temperature', 'Readiness score'], howto: 'cloud.ouraring.com/oauth/authorize → copy token → Settings → Oura' },
      { name: 'Fitbit', badge: 'FREE API', cls: 'badge-best', sub: 'Steps, HR, sleep, weight, calories', note: 'Free API with your device. OAuth flow — click Connect in Settings to authorize. Gets daily steps, heart rate zones, sleep data.', tags: ['Steps', 'Sleep', 'HR zones', 'Weight'], howto: 'Settings → Fitness → Fitbit → Connect (OAuth)' },
      { name: 'Garmin', badge: 'FREE API', cls: 'badge-best', sub: 'All Garmin data — apply for API access', note: 'Comprehensive data from all Garmin devices. Need to apply for Health API access at developer.garmin.com (usually approved within a week).', tags: ['All metrics', 'Apply required', 'Comprehensive', 'HRV'], howto: 'developer.garmin.com → apply → Settings → Garmin token' },
      { name: 'Withings', badge: 'FREE API', cls: 'badge-best', sub: 'Blood pressure, weight, sleep mat, thermometer', note: 'Best non-invasive BP monitoring. Free API. Add token in Settings → Fitness → Withings.', tags: ['Blood pressure', 'Weight', 'Sleep mat', 'Temperature'], howto: 'developer.withings.com → OAuth → Settings → Withings token' },
      { name: 'Whoop', badge: 'API AVAILABLE', cls: 'badge-coming', sub: 'Strain, recovery, HRV, sleep — subscription required', note: 'WHOOP API available to developers. Add your token in Settings. Recovery and strain data correlate strongly with glucose management.', tags: ['Recovery score', 'Strain', 'HRV', 'Sleep'], howto: 'developer.whoop.com → API token → Settings → Whoop' },
    ]
  },
  {
    title: 'Coming Soon (2026–2027)',
    devices: [
      { name: 'Niia (PharmaSens)', badge: 'COMING', cls: 'badge-coming', sub: 'First pump + CGM combined patch — screenless, app-controlled', note: 'Potentially the biggest innovation in T1D tech. One patch = your CGM and insulin pump combined. Smartphone-controlled. CE Mark pending in Europe.', tags: ['All-in-one', 'Patch', 'Screenless', 'Europe first'], howto: 'Not yet available' },
      { name: 'Continuous Ketone Monitor', badge: 'COMING 2026', cls: 'badge-coming', sub: 'First CGM measuring both glucose AND ketones in real-time', note: 'Near FDA approval. Will revolutionize DKA prevention. su94r will integrate it the day the API is available.', tags: ['Glucose + Ketones', 'DKA prevention', 'Real-time', 'FDA pending'], howto: 'API integration planned on launch' },
      { name: 'Omnipod 8-Series', badge: 'COMING', cls: 'badge-coming', sub: 'Next-gen pod · 300 units · Better algorithm · Pivotal trials 2025', note: '50% more insulin capacity. Pivotal trials in 2025. Expected commercial launch 2026-2027.', tags: ['300 units', 'New algorithm', 'Trials 2025'], howto: 'Coming — connect same as Omnipod 5' },
    ]
  },
];

export default function Devices() {
  const [search, setSearch] = useState('');

  const filtered = SECTIONS.map(s => ({
    ...s,
    devices: s.devices.filter(d =>
      !search || d.name.toLowerCase().includes(search.toLowerCase()) || d.note.toLowerCase().includes(search.toLowerCase())
    )
  })).filter(s => s.devices.length > 0);

  return (
    <div className="page fade-up">
      <div className="page-header">
        <h1>Devices</h1>
        <div className="page-subtitle">2026 GUIDE</div>
      </div>

      <div className="info-card">
        💡 All connections require your existing device account. su94r never shares your credentials — everything stays on your device. Always consult your endocrinologist before switching devices.
      </div>

      {/* Search */}
      <input
        style={{ width: '100%', background: 'var(--card)', border: '1px solid var(--border2)', borderRadius: 12, padding: '10px 14px', color: 'var(--text)', fontFamily: 'var(--ui)', fontSize: 14, outline: 'none', marginBottom: 16 }}
        placeholder="🔍 Search devices…"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {filtered.map(section => (
        <div key={section.title}>
          <div className="device-section-title">{section.title}</div>
          {section.devices.map((d, i) => (
            <div key={i} className="device-card">
              <div className="device-top">
                <div className="device-name">{d.name}</div>
                {d.badge && <span className={`device-badge ${d.cls}`}>{d.badge}</span>}
              </div>
              <div className="device-sub">{d.sub}</div>
              <div className="device-note">{d.note}</div>
              {d.howto && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--cyan)', fontFamily: 'var(--mono)', background: 'rgba(6,182,212,0.06)', padding: '5px 10px', borderRadius: 6, display: 'inline-block' }}>
                  ▶ {d.howto}
                </div>
              )}
              <div className="device-tags">{d.tags.map((t, j) => <span key={j} className="device-tag">{t}</span>)}</div>
            </div>
          ))}
        </div>
      ))}

      <div style={{ height: 16 }} />
    </div>
  );
}
