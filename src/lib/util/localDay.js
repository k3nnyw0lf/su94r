// ═══════════════════════════════════════════════════════════════════════════
// Local-time day boundaries.
//
// THE BUG THIS FIXES
//
// Three modules computed the day a reading belonged to with
// `new Date(t).toISOString().slice(0, 10)`, which is UTC.
//
// In Miami (UTC-4) every reading after 20:00 local carries a UTC date of the
// following day. So an evening resistance session and the glucose response it
// caused were filed under different days: the workout on Monday, its overnight
// tail on Tuesday. Time in range, the training-versus-rest comparison, sleep
// pairing and the activity leaderboard were all quietly wrong, and the error is
// invisible — the numbers look plausible, they are just attached to the wrong
// dates.
//
// It gets worse on travel. Flying Miami to Madrid shifts the boundary six
// hours mid-series, so one local day is split and another merged.
//
// Everything that groups by day must come through here.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The user's timezone. Resolved once from the browser, overridable for tests
 * and for the Worker, which has no browser to ask.
 */
export function resolveTimeZone(explicit = null) {
  if (explicit) return explicit;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const formatterCache = new Map();

function partsFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      // en-CA yields YYYY-MM-DD, which sorts lexicographically. That property
      // is relied on everywhere days are ordered.
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
    );
  }
  return formatterCache.get(timeZone);
}

/**
 * The calendar day a timestamp falls on, in the given zone.
 * @returns {string} YYYY-MM-DD, or '' when the input is unusable.
 */
export function localDayKey(t, timeZone = resolveTimeZone()) {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const parts = partsFormatter(timeZone).formatToParts(d);
  const get = type => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Hour of day (0-23) in the given zone.
 *
 * Night-time logic depends on this. Using UTC hours would have meant the
 * "quiet hours" of the sedentary nudge, and the night window of the escalation
 * ladder, firing at the wrong times for anyone not on UTC — silencing alerts
 * during the evening and allowing them at 4am.
 */
export function localHour(t, timeZone = resolveTimeZone()) {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  const parts = partsFormatter(timeZone).formatToParts(d);
  const h = parts.find(p => p.type === 'hour')?.value;
  // Some locales render midnight as 24 under hour12:false.
  const n = Number(h);
  return Number.isFinite(n) ? n % 24 : null;
}

/** Day key shifted by n days, computed through local time so DST is respected. */
export function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Detects timezone changes inside a series — i.e. travel.
 *
 * Worth surfacing rather than hiding: a day that is 23 or 25 hours long, or a
 * flight across several zones, makes that day's statistics genuinely odd, and
 * a user seeing an unexplained dip should be told why.
 */
export function detectZoneShifts(readings = [], timeZone = resolveTimeZone()) {
  const offsets = new Map();
  for (const r of readings) {
    const t = new Date(r.timestamp || r.recorded_at);
    if (Number.isNaN(t.getTime())) continue;
    const key = localDayKey(t, timeZone);
    if (!key || offsets.has(key)) continue;
    // Offset in minutes for that instant, which also captures DST changes.
    const utc = new Date(t.toLocaleString('en-US', { timeZone: 'UTC' }));
    const local = new Date(t.toLocaleString('en-US', { timeZone }));
    offsets.set(key, Math.round((local - utc) / 60000));
  }

  const days = [...offsets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const shifts = [];
  for (let i = 1; i < days.length; i++) {
    const delta = days[i][1] - days[i - 1][1];
    if (delta !== 0) {
      shifts.push({
        day: days[i][0],
        deltaMinutes: delta,
        note: Math.abs(delta) === 60
          ? 'Daylight saving change — that day is 23 or 25 hours long.'
          : `Clock shifted ${delta > 0 ? '+' : ''}${delta / 60}h. Statistics for that day span an unusual length.`,
      });
    }
  }
  return shifts;
}
