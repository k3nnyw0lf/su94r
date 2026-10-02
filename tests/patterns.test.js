// The pattern finder (extension/patterns.js) and Alexa's "what patterns do you see?". What must
// hold: it finds what was built into made-up weeks (lows at the same hour, a rise before waking,
// a bigger rise after breakfast, weekends apart) and nothing in a steady week; it waits for 5 good
// days; it describes and never advises.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findPatterns } from '../extension/patterns.js';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';

const MIN = 60e3, DAY = 864e5;
const TZ = 'America/New_York';
// New York in October is UTC-4: local hour h on day d (October 2026).
const local = (d, h, m = 0) => Date.UTC(2026, 9, d, h + 4, m);
const NOW = local(15, 12, 0);

/** 14 days of readings every 15 minutes from a function of (day, local minute). */
function week(fn) {
  const pts = [];
  for (let d = 1; d <= 15; d++) for (let m = 0; m < 1440; m += 15) {
    const t = local(d, 0, m);
    if (t > NOW - 14 * DAY && t <= NOW) pts.push({ t, mg: fn(d, m) });
  }
  return pts;
}

describe('the pattern finder', () => {
  it('finds lows at the same hour, a rise before waking, and a bigger rise after breakfast', () => {
    const pts = week((d, m) => {
      let mg = 120;
      if (m >= 180 && m <= 420) mg += (m - 180) / 240 * 40;                 // 3 → 7 AM: +40
      if (d % 3 === 0 && m >= 150 && m < 180) mg = 62;                        // lows 2:30–3 AM on days 3, 6, 9, 12, 15
      if (m >= 480 && m < 660) mg += Math.sin(((m - 480) / 180) * Math.PI) * 90;   // after 8 AM breakfast
      if (m >= 780 && m < 960) mg += Math.sin(((m - 780) / 180) * Math.PI) * 35;   // after 1 PM lunch
      return Math.round(mg);
    });
    const events = [];
    for (let d = 2; d <= 14; d++) events.push({ t: local(d, 8), type: 'insulin', kind: 'rapid', amount: 5 }, { t: local(d, 13), type: 'meal', amount: 45 });
    const r = findPatterns(pts, events, { now: NOW, tz: TZ });
    const texts = r.patterns.map((p) => p.text);
    expect(r.days).toBeGreaterThanOrEqual(13);
    expect(texts[0]).toMatch(/^Lows on 5 of the last \d+ days between 2 AM and 4 AM\.$/);
    expect(texts.some((t) => /rises about 40 mg\/dL between 3 and 7 AM/.test(t))).toBe(true);
    expect(texts.some((t) => /^After breakfast, glucose rises about \d+ mg\/dL .* peaking about 1 h 30 min later\. Less after lunch/.test(t))).toBe(true);
    for (const t of texts) expect(t).not.toMatch(/\b(take|inject|dose|should|try)\b/i);
  });

  it('weekdays and weekends apart', () => {
    const pts = week((d, m) => {
      const weekend = [0, 6].includes(new Date(Date.UTC(2026, 9, d)).getUTCDay());
      return weekend && m >= 720 && m < 1200 ? 230 : 130;
    });
    const r = findPatterns(pts, [], { now: NOW, tz: TZ });
    expect(r.patterns.map((p) => p.text)).toContainEqual(expect.stringMatching(/^Time in range is 100% on weekdays and \d+% on weekends\.$/));
  });

  it('nothing to say about a steady fortnight; waits for 5 good days', () => {
    expect(findPatterns(week(() => 125), [], { now: NOW, tz: TZ })).toMatchObject({ patterns: [], note: expect.stringMatching(/^No clear patterns in the last \d+ days\.$/) });
    const short = week(() => 125).filter((p) => p.t > NOW - 3 * DAY);
    const r = findPatterns(short, [], { now: NOW, tz: TZ });
    expect(r.patterns).toEqual([]);
    expect(r.days).toBeLessThan(5);
    expect(r.note).toBe(`Patterns need at least 5 days of readings; there are ${r.days} so far.`);
  });

  it('speaks millimoles when the person uses them', () => {
    const pts = week((d, m) => (m >= 180 && m <= 420 ? 120 + (m - 180) / 240 * 40 : 120));
    const r = findPatterns(pts, [], { now: NOW, tz: TZ, fmt: (mg) => (mg / 18.0182).toFixed(1), unit: 'mmol/L' });
    expect(r.patterns[0].text).toMatch(/rises about 2\.2 mmol\/L/);
  });
});

describe('Alexa: "what patterns do you see?"', () => {
  const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123', ALEXA_SKILL_ID: 'amzn1.ask.skill.test' };
  beforeEach(() => {
    resetCaches();
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url);
      const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
      if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
      const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: null };
      if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
      return res({ status: 0, data: { connection: conn, graphData: [] } });
    }));
  });
  const ask = async (points) => {
    const req = new Request('https://cgm.test/alexa', { method: 'POST', body: JSON.stringify({ version: '1.0', context: { System: { application: { applicationId: 'amzn1.ask.skill.test' } } }, request: { type: 'IntentRequest', timestamp: new Date().toISOString(), intent: { name: 'PatternIntent', slots: {}, confirmationStatus: 'NONE' } } }) });
    const r = await (await handleCgm('alexa', req, ENV, { verifyAlexa: async () => {}, store: { ready: true, async recent() { return []; }, async between() { return []; } }, history: { ready: true, async range() { return points; } } })).json();
    return r.response.outputSpeech.text;
  };

  it('says what repeats, without letters for units; or why it cannot yet', async () => {
    const now = Date.now();
    const pts = [];
    for (let t = now - 14 * DAY; t <= now; t += 15 * MIN) {
      const h = new Date(t).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
      pts.push({ t, mg: Number(h) >= 3 && Number(h) < 7 ? 120 + (Number(h) - 3) * 12 : 120 });
    }
    const text = await ask(pts);
    expect(text).toMatch(/^Over the last \d+ days: On most mornings glucose rises about \d+ between 3 and 7 AM/);
    expect(text).not.toMatch(/mg\/dL/);
    expect(await ask(pts.slice(-50))).toMatch(/^Patterns need at least 5 days of readings/);
  });
});
