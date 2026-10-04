// Everything the server keeps for one person over a period, as one CSV (opens in Excel, Numbers,
// Google Sheets): readings, insulin, carbs, notes, meter readings, ketones, weight, exercise and
// pills, oldest first. The phone app downloads it (app/export); su94r Mini copies each month to
// Google Drive (export?key=, owner key).
//
// Columns: local time, ISO time, type, value, unit, detail, source.

const DAY = 864e5;
const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** The CSV text for one person between two times. Each store is optional. */
export async function exportCsv(pid, { from, to, history, doses, notes, checks, tz = 'America/New_York', units = 'mg/dL' }) {
  const rows = [];
  const mmol = units === 'mmol/L';
  const glucose = (mg) => (mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));
  try { if (history?.ready) for (const r of await history.range(pid, from, to)) rows.push([r.t, 'reading', glucose(r.mg), units, '', 'sensor']); } catch { /* without readings */ }
  try {
    if (doses?.ready) {
      for (let a = from; a < to; a += 30 * DAY) {
        for (const d of await doses.between(pid, a, Math.min(to, a + 30 * DAY))) {
          rows.push(d.kind === 'carbs' ? [d.t, 'carbs', d.amount ?? '', 'g', '', d.source] : [d.t, 'insulin', d.amount ?? '', 'u', d.kind, d.source]);
        }
      }
    }
  } catch { /* without doses */ }
  try { if (notes?.ready) for (const n of await notes.between(pid, from, to)) rows.push([n.t, 'note', '', '', [n.text, (n.tags || []).join(' ')].filter(Boolean).join(' · '), n.by || 'phone']); } catch { /* without notes */ }
  try {
    if (checks?.ready) {
      for (const c of await checks.between(pid, from, to)) {
        if (c.kind === 'meter') rows.push([c.t, 'meter', glucose(c.value), units, '', c.by || c.source]);
        else if (c.kind === 'ketone') rows.push([c.t, 'ketones', c.value ?? c.label, c.unit === 'urine' ? 'urine' : 'mmol/L', '', c.by || c.source]);
        else if (c.kind === 'weight') rows.push([c.t, 'weight', c.value, 'kg', '', c.by || c.source]);
        else if (c.kind === 'exercise') rows.push([c.t, 'exercise', c.value, 'min', c.label, c.by || c.source]);
        else rows.push([c.t, 'pill', c.value ?? '', c.unit, c.label, c.by || c.source]);
      }
    }
  } catch { /* without checks */ }
  rows.sort((a, b) => a[0] - b[0]);
  const local = (t) => { try { return new Date(t).toLocaleString('sv-SE', { timeZone: tz }).replace('T', ' '); } catch { return new Date(t).toISOString(); } };
  const lines = ['local time,iso time,type,value,unit,detail,source', ...rows.map((r) => [local(r[0]), new Date(r[0]).toISOString(), ...r.slice(1)].map(cell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
