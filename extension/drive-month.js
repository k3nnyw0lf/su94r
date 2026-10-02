// The Google Drive month file (su94r-YYYY-MM.json): pure helpers, shared with the tests.

export const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
export const monthRange = (month) => {
  const [y, m] = month.split('-').map(Number);
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
};

/**
 * Union of two month files. Readings: one per person and minute, a live reading wins.
 * Markers: one per id, minus any id either side deleted. Health: one per (type, time, source).
 */
export function mergeMonth(a, b) {
  const out = { app: 'su94r', version: 1, month: a?.month || b?.month, people: { ...(a?.people || {}), ...(b?.people || {}) } };
  const readings = {};
  for (const src of [a, b]) {
    for (const [pid, rows] of Object.entries(src?.readings || {})) {
      const m = (readings[pid] ??= new Map());
      for (const [t, mg, s] of rows) {
        const old = m.get(t);
        if (!old || (s === 'live' && old[2] !== 'live')) m.set(t, [t, mg, s]);
      }
    }
  }
  out.readings = Object.fromEntries(Object.entries(readings).map(([pid, m]) => [pid, [...m.values()].sort((x, y) => x[0] - y[0])]));
  out.deleted = [...new Set([...(a?.deleted || []), ...(b?.deleted || [])])];
  const gone = new Set(out.deleted);
  const markers = new Map();
  for (const src of [a, b]) for (const e of src?.markers || []) if (!gone.has(e.id)) markers.set(e.id, e);
  out.markers = [...markers.values()].sort((x, y) => x.t - y.t);
  const health = new Map();
  for (const src of [a, b]) for (const h of src?.health || []) health.set(`${h.type}|${h.t}|${h.src}`, h);
  out.health = [...health.values()].sort((x, y) => x.t - y.t);
  return out;
}
