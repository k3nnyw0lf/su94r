// Calendar heads-up: reads your calendar's private address (an iCal / .ics link, such as
// Google Calendar's "Secret address in iCal format") and, before a meeting, a drive or a
// workout, says so if your glucose is low, falling toward low, or high. Pure parsing and
// decisions; the background worker fetches the link and shows the notice.

const MIN = 60e3;

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/** Parses an iCal date: 20261002T140000Z, 20261002T140000 (with TZID), or 20261002 (all day). */
export function icsDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  if (!m[4]) return { t: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  const tz = params.TZID;
  if (!tz) return { t: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
  // Wall time in a named zone: find the UTC instant whose local time there matches.
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const offset = (at) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at;
  };
  try {
    let t = guess - offset(guess);
    t = guess - offset(t);
    return { t, allDay: false };
  } catch {
    return { t: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
  }
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Events between `from` and `to`: { uid, title, start, end, allDay }. Daily and weekly repeats are expanded. */
export function parseIcs(text, from, to) {
  const out = [];
  const blocks = unfold(text).split('BEGIN:VEVENT').slice(1).map((b) => b.split('END:VEVENT')[0]);
  const cancelled = new Set();
  for (const b of blocks) {
    const props = {};
    const exdates = [];
    for (const line of b.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...rawParams] = line.slice(0, i).split(';');
      const params = Object.fromEntries(rawParams.map((p) => p.split('=')));
      const value = line.slice(i + 1).trim();
      if (name === 'EXDATE') for (const v of value.split(',')) { const d = icsDate(v, params); if (d) exdates.push(d.t); }
      else props[name] = { value, params };
    }
    if (!props.DTSTART) continue;
    if (props.STATUS?.value === 'CANCELLED') continue;
    const start = icsDate(props.DTSTART.value, props.DTSTART.params);
    if (!start) continue;
    const endP = props.DTEND ? icsDate(props.DTEND.value, props.DTEND.params) : null;
    const length = endP ? endP.t - start.t : start.allDay ? 864e5 : 60 * MIN;
    const title = (props.SUMMARY?.value || 'Event').replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ').slice(0, 120);
    const uid = props.UID?.value || `${title}|${start.t}`;
    if (props['RECURRENCE-ID']) {
      // An edited single occurrence: it replaces the repeat on that date.
      const rid = icsDate(props['RECURRENCE-ID'].value, props['RECURRENCE-ID'].params);
      if (rid) cancelled.add(`${uid}|${rid.t}`);
    }
    const starts = [start.t];
    const rule = props.RRULE?.value;
    if (rule) {
      const r = Object.fromEntries(rule.split(';').map((p) => p.split('=')));
      const until = r.UNTIL ? icsDate(r.UNTIL)?.t ?? Infinity : Infinity;
      const count = r.COUNT ? Number(r.COUNT) : Infinity;
      const interval = Number(r.INTERVAL || 1);
      const byDay = r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS.indexOf(d.slice(-2))) : null;
      if (r.FREQ === 'DAILY' || r.FREQ === 'WEEKLY') {
        let n = 1;
        const step = 864e5;
        for (let t = start.t + step, k = 1; t <= Math.min(to, until) && n < count && k < 3000; t += step, k++) {
          const dayIndex = Math.round((t - start.t) / step);
          const dow = new Date(t).getDay();
          let ok;
          if (r.FREQ === 'DAILY') ok = dayIndex % interval === 0;
          else ok = (byDay ? byDay.includes(dow) : dow === new Date(start.t).getDay()) && Math.floor(dayIndex / 7) % interval === 0;
          if (!ok) continue;
          // Keep the same wall-clock time across a daylight-saving change.
          const d = new Date(start.t);
          const at = new Date(t);
          at.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0);
          starts.push(at.getTime());
          n++;
        }
      }
    }
    for (const s of starts) {
      if (exdates.some((x) => Math.abs(x - s) < MIN)) continue;
      if (s + length < from || s > to) continue;
      out.push({ uid, title, start: s, end: s + length, allDay: start.allDay, recurring: Boolean(rule) && !props['RECURRENCE-ID'] });
    }
  }
  return out.filter((e) => !(e.recurring && cancelled.has(`${e.uid}|${e.start}`))).sort((a, b) => a.start - b.start);
}

/**
 * Whether to give a heads-up for an event starting within `leadMin` minutes. `latest` is the
 * newest reading, `slope` mg/dL per minute, `estimateAtStart` the learner's estimate for the
 * event's start (or null). Returns { level, text } or null.
 */
export function headsUp(event, latest, { slope = 0, estimateAtStart = null, low = 70, high = 250, leadMin = 30, now = Date.now(), fmt = (v) => `${Math.round(v)}` } = {}) {
  if (!event || event.allDay || !latest) return null;
  const minsTo = (event.start - now) / MIN;
  if (minsTo < 0 || minsTo > leadMin) return null;
  if (now - latest.t > 15 * MIN) return null;
  const when = new Date(event.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const ahead = estimateAtStart ?? latest.mg + slope * minsTo;
  const head = `"${event.title}" at ${when}, in ${Math.round(minsTo)} min`;
  if (latest.mg < low) return { level: 'low', text: `${head}. You're ${fmt(latest.mg)}, under your low line.` };
  if (ahead < low + 10 && slope < -0.5) return { level: 'falling', text: `${head}. You're ${fmt(latest.mg)} and falling; by then about ${fmt(Math.max(40, ahead))}.` };
  if (latest.mg > high && slope >= 0) return { level: 'high', text: `${head}. You're ${fmt(latest.mg)} and not coming down yet.` };
  return null;
}
