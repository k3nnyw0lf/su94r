// Parses the "Download glucose data" CSV from LibreView (libreview.com) into readings and markers.
// Column names are matched loosely because LibreView localises and reorders them.

import { MGDL_PER_MMOL } from './glucose.js';

function parseRows(text, delim) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function num(s) {
  const v = Number(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(v) && String(s).trim() !== '' ? v : null;
}

const TS = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i;

export function parseLibreViewCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLines = text.split(/\r?\n/, 4);
  const headerLine = firstLines.find((l) => /timestamp/i.test(l)) || firstLines[1] || '';
  const delim = (headerLine.match(/;/g)?.length || 0) > (headerLine.match(/,/g)?.length || 0) ? ';' : ',';
  const rows = parseRows(text, delim);
  const h = rows.findIndex((r) => r.some((c) => /timestamp/i.test(c)));
  if (h < 0) throw new Error('This does not look like a LibreView glucose export (no timestamp column).');

  const header = rows[h].map((c) => c.trim().toLowerCase());
  const col = (re) => header.findIndex((c) => re.test(c));
  const iTime = col(/timestamp/);
  const iHist = col(/^historic glucose/);
  const iScan = col(/^scan glucose/);
  const mmol = /mmol/.test(header[iHist] || header[iScan] || '');
  const iRapid = col(/^rapid-acting insulin \(units\)/);
  const iLong = col(/^long-acting insulin.*\(units\)/);
  const iCarbs = col(/^carbohydrates \(grams\)/);
  if (iTime < 0 || (iHist < 0 && iScan < 0)) throw new Error('No glucose columns found in this file.');

  const data = rows.slice(h + 1).filter((r) => r[iTime]?.trim());
  const stamps = data.map((r) => TS.exec(r[iTime].trim())).filter(Boolean);
  if (!stamps.length) throw new Error('Could not read the dates in this file.');

  // Work out the date order: year first, month-day (US) or day-month.
  const yearFirst = stamps[0][1].length === 4;
  let dayFirst = false;
  if (!yearFirst) {
    if (stamps.some((m) => Number(m[1]) > 12)) dayFirst = true;
    else if (stamps.some((m) => Number(m[2]) > 12)) dayFirst = false;
    else dayFirst = !stamps.some((m) => m[7]); // no AM/PM usually means a day-first locale
  }

  const toTime = (s) => {
    const m = TS.exec(String(s).trim());
    if (!m) return null;
    let [, a, b, c, hh, mi, ss, ap] = m;
    let y, mo, d;
    if (yearFirst) [y, mo, d] = [a, b, c];
    else if (dayFirst) [d, mo, y] = [a, b, c];
    else [mo, d, y] = [a, b, c];
    let hour = Number(hh);
    if (ap) {
      const pm = ap.toUpperCase() === 'PM';
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    const t = new Date(Number(y), Number(mo) - 1, Number(d), hour, Number(mi), Number(ss || 0)).getTime();
    return Number.isNaN(t) ? null : t;
  };

  const readings = [];
  const events = [];
  for (const r of data) {
    const t = toTime(r[iTime]);
    if (!t) continue;
    const g = num(r[iHist]) ?? num(r[iScan]);
    if (g != null && g > 0) readings.push({ t, mg: Math.round(mmol ? g * MGDL_PER_MMOL : g) });
    const rapid = iRapid >= 0 ? num(r[iRapid]) : null;
    const long = iLong >= 0 ? num(r[iLong]) : null;
    const carbs = iCarbs >= 0 ? num(r[iCarbs]) : null;
    if (rapid) events.push({ t, type: 'insulin', amount: rapid, kind: 'rapid' });
    if (long) events.push({ t, type: 'insulin', amount: long, kind: 'basal' });
    if (carbs) events.push({ t, type: 'meal', amount: carbs });
  }
  readings.sort((a, b) => a.t - b.t);
  return { readings, events, mmol };
}
