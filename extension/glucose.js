// Pure helpers shared by the background worker, the mini window and the settings page.

export const MGDL_PER_MMOL = 18.0182;
export const TREND_ARROWS = ['', '↓', '↘', '→', '↗', '↑'];

export const DEFAULT_ALERTS = {
  enabled: true,
  urgentLowOn: true,
  urgentLow: 55,
  lowOn: true,
  low: 70,
  highOn: true,
  high: 240,
  fallingFast: true,
  risingFast: false,
  noData: true,
  sound: 'urgent', // 'urgent' | 'all' | 'off'
};

export const DEFAULT_SETTINGS = {
  hours: 3,
  units: 'auto',
  openOnStartup: false,
  badge: true,
  demo: false,
  projection: true,
  tiny: false,
  sensorDays: 14,
  sensorReminder: true,
  rapidInsulin: 'novorapid',
  meds: [],
  alerts: DEFAULT_ALERTS,
};

export function withDefaults(s = {}) {
  return { ...DEFAULT_SETTINGS, ...s, alerts: { ...DEFAULT_ALERTS, ...(s?.alerts || {}) } };
}

export const EVENT_TYPES = {
  meal: { icon: '🍽️', label: 'Meal', unit: 'g carbs' },
  insulin: { icon: '💉', label: 'Insulin', unit: 'units' },
  exercise: { icon: '🏃', label: 'Exercise', unit: 'min' },
  med: { icon: '💊', label: 'Medicine', unit: '' },
};

// Same categories and wording as su94r's insulin catalog (src/lib/insulin/catalog.js).
export const INSULIN_KINDS = {
  rapid: 'Rapid-acting (mealtime)',
  short: 'Short-acting (regular)',
  intermediate: 'Intermediate (NPH)',
  basal: 'Long-acting (basal)',
  mix: 'Pre-mixed',
};

export const INJECTION_SITES = {
  'belly-l': 'Belly, left',
  'belly-r': 'Belly, right',
  'thigh-l': 'Thigh, left',
  'thigh-r': 'Thigh, right',
  'arm-l': 'Arm, left',
  'arm-r': 'Arm, right',
  'buttock-l': 'Buttock, left',
  'buttock-r': 'Buttock, right',
};
export const siteArea = (site) => String(site || '').split('-')[0] || null;

/** "Insulin 4 units · Long-acting (basal) · Belly, left", "Meal 45 g carbs". */
export function markerLabel(e) {
  if (e.type === 'med') return `${e.medName || 'Medicine'}${e.amount != null ? ` ${e.amount} ${e.unit || ''}`.trimEnd() : ''}`;
  const type = EVENT_TYPES[e.type] || { label: e.type, unit: '' };
  const amount = e.amount != null ? ` ${e.amount} ${type.unit}` : '';
  const detail = [e.medName, e.kind ? INSULIN_KINDS[e.kind] || e.kind : e.note, e.site ? INJECTION_SITES[e.site] || e.site : null].filter(Boolean).join(' · ');
  return `${type.label}${amount}${detail ? ` · ${detail}` : ''}`;
}

export function displayUnits(settings, patient) {
  return settings?.units && settings.units !== 'auto' ? settings.units : patient?.units || 'mg/dL';
}

export function fmtGlucose(mg, units) {
  return units === 'mmol/L' ? (mg / MGDL_PER_MMOL).toFixed(1) : String(Math.round(mg));
}

export function fmtDelta(mgDiff, units) {
  const v = units === 'mmol/L' ? Math.abs(mgDiff / MGDL_PER_MMOL).toFixed(1) : String(Math.abs(Math.round(mgDiff)));
  return `${mgDiff < 0 ? '−' : '+'}${v}`;
}

// Minute-by-minute readings win; the coarser history fills the rest. Both inputs are [t, mg] pairs.
export function mergeSeries(hist = [], live = []) {
  const fine = live.map(([t, mg]) => ({ t, mg }));
  const out = [...fine];
  let j = 0;
  for (const [t, mg] of hist) {
    while (j < fine.length && fine[j].t < t - 180e3) j++;
    if (j < fine.length && fine[j].t <= t + 180e3) continue;
    out.push({ t, mg });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Time-weighted stats. Each reading counts until the next one, capped at 15 min so gaps don't skew it.
// A low episode is 15+ minutes below the low limit (international CGM consensus).
export function rangeStats(points, from, to, low, high) {
  const pts = points.filter((p) => p.t >= from && p.t <= to);
  let total = 0, inRange = 0, below = 0, above = 0, sum = 0, lows = 0, lowRun = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    const dur = Math.min(next ? next.t - p.t : 5 * 60e3, 15 * 60e3);
    total += dur;
    sum += p.mg * dur;
    if (p.mg < low) {
      below += dur;
      lowRun += dur;
    } else {
      if (lowRun >= 15 * 60e3) lows++;
      lowRun = 0;
      if (p.mg > high) above += dur;
      else inRange += dur;
    }
  }
  if (lowRun >= 15 * 60e3) lows++;
  if (!total) return null;
  return { hours: total / 3600e3, inRange: inRange / total, below: below / total, above: above / total, avg: sum / total, lows };
}

// Straight-line projection from the last 20 minutes. Returns null when there is too little recent data.
export function project(points, latest, minutesAhead = 20) {
  if (!latest) return null;
  const win = points.filter((p) => p.t >= latest.t - 20 * 60e3 && p.t < latest.t - 30e3);
  win.push({ t: latest.t, mg: latest.mg });
  if (win.length < 3 || latest.t - win[0].t < 8 * 60e3) return null;
  const xs = win.map((p) => (p.t - latest.t) / 60e3);
  const ys = win.map((p) => p.mg);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (!den) return null;
  const slope = Math.max(-4, Math.min(4, num / den));
  const mg = Math.max(40, Math.min(400, Math.round(latest.mg + slope * minutesAhead)));
  return { t: latest.t + minutesAhead * 60e3, mg, slope };
}

export function sensorStatus(sensor, wearDays, now = Date.now()) {
  if (!sensor?.start) return null;
  const end = sensor.start + wearDays * 864e5;
  const warmEnd = sensor.start + 60 * 60e3;
  if (now < warmEnd) return { kind: 'warming', left: warmEnd - now, end };
  if (now >= end) return { kind: 'ended', left: 0, end };
  return { kind: 'active', left: end - now, end };
}

export function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60e3));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m} min`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function localDate(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(points, events) {
  const rows = [
    ...points.map((p) => ({ t: p.t, cells: [p.mg, (p.mg / MGDL_PER_MMOL).toFixed(1), '', '', '', ''] })),
    ...events.map((e) => ({ t: e.t, cells: ['', '', EVENT_TYPES[e.type]?.label || e.type, e.amount ?? '', e.amount != null ? (e.type === 'med' ? e.unit || '' : EVENT_TYPES[e.type]?.unit || '') : '', [e.medName, e.kind ? INSULIN_KINDS[e.kind] || e.kind : e.note, e.site ? INJECTION_SITES[e.site] || e.site : null].filter(Boolean).join('; ')] })),
  ].sort((a, b) => a.t - b.t);
  const lines = [['Date', 'Time', 'Glucose (mg/dL)', 'Glucose (mmol/L)', 'Marker', 'Amount', 'Amount unit', 'Detail']];
  for (const r of rows) lines.push([localDate(r.t), localTime(r.t), ...r.cells]);
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
