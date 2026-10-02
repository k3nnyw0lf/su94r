// Tests for the extension's dose memory, insulin timing, medicines, sync and AI summary.
//
// The cases that matter most protect against the mistake this feature exists for:
// taking the same dose twice. The double-dose guard must look both ways in time,
// long-acting insulin must never be counted as active rapid insulin, and an insulin
// added from the medicine list must land in the right category, or the guard and the
// active-insulin figure quietly stop protecting anyone.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { activeFraction, insulinOnBoard, lastDose, doubleDoseWarning, medDuplicateWarning, BOLUS_KINDS } from '../extension/insulin.js';
import { insulinTiming } from '../extension/insights.js';
import { prettyName, insulinKindFromName, defaultUnit, parseStrength } from '../extension/meds.js';
import { markerLabel, toCsv } from '../extension/glucose.js';
import { buildSummary, pickOllamaModel, SYSTEM_PROMPT } from '../extension/ai.js';
import { activeFraction as su94rActiveFraction } from '../src/lib/insulin/iob.js';

const NOW = Date.UTC(2026, 9, 1, 18);
const MIN = 60e3;
const dose = (minsAgo, amount, kind, extra = {}) => ({ id: `${kind}-${minsAgo}`, p: 'a', t: NOW - minsAgo * MIN, type: 'insulin', amount, kind, ...extra });

describe('active insulin', () => {
  it('uses exactly the same curve as su94r', () => {
    for (const t of [0, 30, 75, 120, 240, 359, 400]) {
      expect(activeFraction(t, { peakMin: 75, durationMin: 360 })).toBeCloseTo(su94rActiveFraction(t, { peakMin: 75, durationMin: 360 }), 10);
    }
  });
  it('counts rapid and regular insulin, never long-acting, NPH or pre-mixed', () => {
    const events = [dose(30, 4, 'rapid'), dose(60, 20, 'basal'), dose(60, 10, 'intermediate'), dose(60, 10, 'mix')];
    const iob = insulinOnBoard(events, 'a', {}, NOW);
    expect(iob).toBeGreaterThan(3);
    expect(iob).toBeLessThan(4);
  });
  it('treats a dose with no type as rapid', () => {
    expect(insulinOnBoard([{ ...dose(30, 4, 'rapid'), kind: undefined }], 'a', {}, NOW)).toBeGreaterThan(3);
  });
  it('ignores other people and doses an hour in the future', () => {
    expect(insulinOnBoard([{ ...dose(30, 4, 'rapid'), p: 'b' }, dose(-60, 4, 'rapid')], 'a', {}, NOW)).toBe(0);
  });
  it('counts a dose stamped a few minutes ahead by a computer whose clock runs fast', () => {
    expect(insulinOnBoard([dose(-5, 4, 'rapid')], 'a', {}, NOW)).toBe(4);
    expect(lastDose([dose(-5, 4, 'rapid')], 'a', BOLUS_KINDS, NOW)?.amount).toBe(4);
  });
  it('finds the most recent dose of a kind', () => {
    expect(lastDose([dose(200, 3, 'rapid'), dose(30, 4, 'rapid'), dose(10, 20, 'basal')], 'a', BOLUS_KINDS, NOW).amount).toBe(4);
  });
});

describe('double-dose guard', () => {
  it('warns about a second rapid dose within 3 hours, with active insulin', () => {
    const w = doubleDoseWarning([dose(45, 4, 'rapid')], 'a', { t: NOW, kind: 'rapid' }, {}, NOW);
    expect(w).toMatch(/already logged 4 u rapid 45 min ago \(\d\.\d u still active\)/);
  });
  it('looks both ways in time, for a dose logged after the fact', () => {
    expect(doubleDoseWarning([dose(45, 4, 'rapid')], 'a', { t: NOW - 100 * MIN, kind: 'rapid' }, {}, NOW)).toMatch(/55 min after this time/);
  });
  it('catches a repeated long-acting dose within 16 hours', () => {
    expect(doubleDoseWarning([dose(10 * 60, 20, 'basal')], 'a', { t: NOW, kind: 'basal' }, {}, NOW)).toMatch(/already logged 20 u long-acting/);
  });
  it('does not mix up rapid and long-acting', () => {
    expect(doubleDoseWarning([dose(30, 20, 'basal')], 'a', { t: NOW, kind: 'rapid' }, {}, NOW)).toBeNull();
  });
  it('counts a dose logged without an amount', () => {
    const noAmount = { id: 'n', p: 'a', t: NOW - 40 * MIN, type: 'insulin', kind: 'rapid' };
    expect(doubleDoseWarning([noAmount], 'a', { t: NOW, kind: 'rapid' }, {}, NOW)).toContain('a rapid dose (amount not logged) 40 min ago');
    expect(lastDose([noAmount], 'a', BOLUS_KINDS, NOW)?.id).toBe('n');
  });
  it('guards NPH and pre-mixed doses', () => {
    expect(doubleDoseWarning([dose(6 * 60, 12, 'intermediate')], 'a', { t: NOW, kind: 'intermediate' }, {}, NOW)).toMatch(/12 u NPH/);
    expect(doubleDoseWarning([dose(6 * 60, 12, 'mix')], 'a', { t: NOW, kind: 'intermediate' }, {}, NOW)).toMatch(/pre-mixed/);
    expect(doubleDoseWarning([dose(2 * 60, 4, 'rapid')], 'a', { t: NOW, kind: 'mix' }, {}, NOW)).toMatch(/4 u rapid/);
    expect(doubleDoseWarning([dose(2 * 60, 10, 'mix')], 'a', { t: NOW, kind: 'rapid' }, {}, NOW)).toMatch(/pre-mixed/);
    expect(doubleDoseWarning([dose(9 * 60, 12, 'intermediate')], 'a', { t: NOW, kind: 'intermediate' }, {}, NOW)).toBeNull();
  });
  it('stays quiet outside the window', () => {
    expect(doubleDoseWarning([dose(4 * 60, 4, 'rapid')], 'a', { t: NOW, kind: 'rapid' }, {}, NOW)).toBeNull();
  });
  it('flags the same medicine twice within 4 hours, by id or name', () => {
    const med = { id: 'm', p: 'a', t: NOW - 90 * MIN, type: 'med', medId: '861007', medName: 'Metformin 500 mg', amount: 1, unit: 'tablet' };
    expect(medDuplicateWarning([med], 'a', { t: NOW, medId: '861007', medName: 'Metformin 500 mg' }, NOW)).toMatch(/already logged Metformin 500 mg 1 tablet 1 h 30 min ago/);
    expect(medDuplicateWarning([med], 'a', { t: NOW, medId: 'other', medName: 'Lisinopril' }, NOW)).toBeNull();
  });
});

describe('insulin timing from history', () => {
  const build = (profile, days, withExercise, site) => {
    const pts = [];
    const ev = [];
    for (const d of days) {
      const t0 = NOW - d * 864e5;
      ev.push({ id: `i${d}`, p: 'a', t: t0, type: 'insulin', amount: 3, kind: 'rapid', site });
      if (withExercise) ev.push({ id: `x${d}`, p: 'a', t: t0 + 30 * MIN, type: 'exercise', amount: 30 });
      for (let m = -30; m <= 330; m++) pts.push({ t: t0 + m * MIN, mg: 220 - 90 * (1 - activeFraction(Math.max(0, m), profile)) + 2 * Math.sin(m * 1.7) });
    }
    return { pts, ev };
  };
  it('recovers start, hardest and mostly-done times close to the truth', () => {
    const { pts, ev } = build({ peakMin: 75, durationMin: 360 }, [1, 2, 3, 4], false);
    const r = insulinTiming(pts.sort((a, b) => a.t - b.t), ev, 'a', { now: NOW });
    expect(r.enough).toBe(true);
    expect(r.correction.onset).toBeGreaterThan(25);
    expect(r.correction.onset).toBeLessThan(55);
    expect(r.correction.end).toBeGreaterThan(180);
    expect(r.correction.end).toBeLessThan(260);
  });
  it('separates exercise days from sitting days', () => {
    const a = build({ peakMin: 45, durationMin: 300 }, [1, 2, 3], true);
    const b = build({ peakMin: 75, durationMin: 360 }, [4, 5, 6], false);
    const r = insulinTiming([...a.pts, ...b.pts].sort((x, y) => x.t - y.t), [...a.ev, ...b.ev], 'a', { now: NOW });
    expect(r.split.withExercise.end).toBeLessThan(r.split.withoutExercise.end);
  });
  it('compares injection areas when there are enough of each', () => {
    const a = build({ peakMin: 55, durationMin: 300 }, [1, 2, 3], false, 'belly-l');
    const b = build({ peakMin: 85, durationMin: 380 }, [4, 5, 6], false, 'thigh-r');
    const r = insulinTiming([...a.pts, ...b.pts].sort((x, y) => x.t - y.t), [...a.ev, ...b.ev], 'a', { now: NOW });
    expect(r.bySite.belly.peak).toBeLessThan(r.bySite.thigh.peak);
  });
  it('leaves out stacked doses and doses with food nearby, and says so', () => {
    const { pts, ev } = build({ peakMin: 75, durationMin: 360 }, [1], false);
    ev.push({ id: 's', p: 'a', t: NOW - 864e5 + 60 * MIN, type: 'insulin', amount: 1, kind: 'rapid' });
    const r = insulinTiming(pts, ev, 'a', { now: NOW });
    expect(r.enough).toBe(false);
    expect(r.skipped.stacked).toBe(2);
  });
});

describe('medicines', () => {
  it('formats RxNorm names readably', () => {
    expect(prettyName('metformin hydrochloride 500 MG Oral Tablet [Glucophage]')).toBe('Glucophage (metformin hydrochloride 500 mg oral tablet)');
  });
  it('puts insulins from the medicine list in the right category', () => {
    expect(insulinKindFromName('insulin glargine 100 UNT/ML Pen Injector [Lantus]')).toBe('basal');
    expect(insulinKindFromName('insulin degludec 100 UNT/ML [Tresiba]')).toBe('basal');
    expect(insulinKindFromName('insulin lispro 100 UNT/ML [Humalog]')).toBe('rapid');
    expect(insulinKindFromName('insulin aspart 100 UNT/ML [Fiasp]')).toBe('rapid');
    expect(insulinKindFromName('insulin isophane human 100 UNT/ML [Humulin N]')).toBe('intermediate');
    expect(insulinKindFromName('insulin regular human 100 UNT/ML [Humulin R]')).toBe('short');
    expect(insulinKindFromName('insulin lispro protamine 75/25 [Humalog Mix]')).toBe('mix');
  });
  it('picks a sensible logging unit', () => {
    expect(defaultUnit({ isInsulin: true })).toBe('units');
    expect(defaultUnit(parseStrength('metformin 500 MG Oral Tablet'))).toBe('tablet');
  });
});

describe('labels and export', () => {
  it('labels insulin with type and injection site, and medicines by name', () => {
    expect(markerLabel({ type: 'insulin', amount: 4, kind: 'rapid', site: 'belly-l' })).toBe('Insulin 4 units · Rapid-acting (mealtime) · Belly, left');
    expect(markerLabel({ type: 'med', medName: 'Metformin 500 mg', amount: 1, unit: 'tablet' })).toBe('Metformin 500 mg 1 tablet');
  });
  it('exports the insulin type and site in the Detail column', () => {
    const csv = toCsv([], [{ t: NOW, type: 'insulin', amount: 4, kind: 'basal', site: 'thigh-r' }]).split('\r\n');
    expect(csv[0]).toMatch(/,Detail$/);
    expect(csv[1]).toMatch(/,Insulin,4,units,"Long-acting \(basal\); Thigh, right"$/);
  });
});

describe('AI summary', () => {
  it('summarises in the person\'s units and never includes identifiers', () => {
    const points = [];
    for (let t = NOW - 2 * 864e5; t <= NOW; t += 5 * MIN) points.push({ t, mg: 140 + 60 * Math.sin(t / 3600e3) });
    const s = buildSummary({ points, events: [dose(30, 4, 'rapid')], person: { pid: 'patient-uuid-123', name: 'Ana Lopez', firstName: 'Ana', low: 70, high: 180 }, units: 'mmol/L', days: 2, now: NOW });
    expect(s.units).toBe('mmol/L');
    expect(s.targetRange).toEqual([3.9, 10]);
    expect(s.hourOfDay.length).toBeGreaterThan(20);
    expect(s.logged.at(-1)).toMatch(/Insulin 4 units/);
    expect(JSON.stringify(s)).not.toContain('patient-uuid-123');
    expect(JSON.stringify(s)).not.toContain('Lopez');
  });
  it('tells the model never to give doses', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never recommend, calculate or adjust insulin doses/);
  });
  it('prefers the strongest installed local model', () => {
    expect(pickOllamaModel(['llama3.2:3b', 'gemma3:12b', 'qwen2.5:7b'])).toBe('gemma3:12b');
    expect(pickOllamaModel(['llama3.2:3b'])).toBe('llama3.2:3b');
  });
});

// chrome.storage mock for the sync tests: two computers sharing one sync area.
function makeArea({ quota = Infinity } = {}) {
  let data = {};
  const bytes = (d) => Object.entries(d).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
  return {
    QUOTA_BYTES: quota === Infinity ? 102400 : quota,
    data: () => data,
    getBytesInUse: async () => bytes(data),
    get: async (keys) => {
      if (keys == null) return { ...data };
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    set: async (obj) => {
      const next = { ...data, ...structuredClone(obj) };
      if (bytes(next) > quota) throw new Error('QUOTA_BYTES quota exceeded');
      if (quota !== Infinity) for (const [k, v] of Object.entries(obj)) if (k.length + JSON.stringify(v).length > 8192) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      data = next;
    },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

describe('sync between computers', () => {
  let sync, localA, localB;
  beforeEach(() => {
    sync = makeArea({ quota: 102400 });
    localA = makeArea();
    localB = makeArea();
  });
  const on = async (local) => {
    vi.stubGlobal('chrome', { storage: { sync, local, session: makeArea() }, runtime: { getManifest: () => ({ version: 'test' }) } });
    vi.resetModules();
    return import('../extension/sync.js');
  };
  // What the background worker does when sync tells it days changed.
  const pull = async (mod, local, pending) => {
    const { events = [] } = await local.get('events');
    const { events: next } = await mod.mergeDays(await mod.syncedDays(), events, pending);
    if (next) await local.set({ events: next });
    return (await local.get('events')).events || [];
  };
  const dose = (id, minsAgo, extra = {}) => ({ id, p: 'a', t: Date.now() - minsAgo * MIN, type: 'insulin', amount: 4, kind: 'rapid', ...extra });

  it('a dose logged on A reaches B, and a deletion on B reaches A', async () => {
    const d = dose('d1', 10);
    let mod = await on(localA);
    await localA.set({ events: [d] });
    expect(await mod.pushEvents({ upsert: [d] })).toBe(true);
    mod = await on(localB);
    expect(await pull(mod, localB)).toEqual([d]);
    await localB.set({ events: [] });
    await mod.pushEvents({ remove: [d] });
    mod = await on(localA);
    expect(await pull(mod, localA)).toEqual([]);
  });

  it('a deletion always wins; an undo (a fresh id) stays', async () => {
    const d = dose('d1', 10);
    const mod = await on(localA);
    await mod.pushEvents({ upsert: [d] });
    await mod.pushEvents({ remove: [d] });
    await mod.pushEvents({ upsert: [d] });                   // a stale copy re-sending the deleted dose
    await mod.pushEvents({ upsert: [{ ...d, id: 'd2' }] });  // the window's undo
    const other = await on(localB);
    await localB.set({ events: [d] });                       // B still had the old one
    expect((await pull(other, localB)).map((e) => e.id)).toEqual(['d2']);
    expect([...(await other.tombstoned([d]))]).toEqual(['d1']);
  });

  it('notices a marker lost when two computers wrote the same day at once', async () => {
    const a = dose('a1', 20);
    const b = dose('b1', 10);
    const mod = await on(localA);
    await mod.pushEvents({ upsert: [a] });
    // B read the day before A wrote, then wrote its own version: A's marker is gone from sync.
    const day = Object.keys(sync.data()).find((k) => k.startsWith('ev:'));
    await sync.set({ [day]: { e: [b], x: [] } });
    const { events: next, missing } = await mod.mergeDays([day.slice(3)], [a]);
    expect(next.map((e) => e.id).sort()).toEqual(['a1', 'b1']);
    expect(missing.map((e) => e.id)).toEqual(['a1']);   // the worker sends it again
  });

  it('keeps markers another computer added to the same day', async () => {
    let mod = await on(localA);
    await mod.pushEvents({ upsert: [{ id: 'a1', p: 'a', t: Date.now() - 20 * MIN, type: 'meal', amount: 40 }] });
    mod = await on(localB);
    await mod.pushEvents({ upsert: [dose('b1', 10)] });
    expect((await pull(mod, localB)).map((e) => e.id).sort()).toEqual(['a1', 'b1']);
  });

  it('changes still waiting to be sent win over what sync holds', async () => {
    const d = dose('d1', 10);
    const mod = await on(localA);
    await mod.pushEvents({ upsert: [d] });
    await localB.set({ events: [] });
    const b = await on(localB);
    // B deleted d1 but could not send the deletion yet: a pull must not bring it back.
    expect(await pull(b, localB, { remove: new Set(['d1']) })).toEqual([]);
  });

  it('a busy day is split across items and comes back whole', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}-${'x'.repeat(30)}`, p: 'a', t: Date.now() - (i % 50) * MIN, type: 'meal', amount: i, note: 'lunch at the office' }));
    const mod = await on(localA);
    expect(await mod.pushEvents({ upsert: many })).toBe(true);
    const keys = Object.keys(sync.data()).filter((k) => k.startsWith('ev:'));
    expect(keys.length).toBeGreaterThan(1);
    const b = await on(localB);
    expect((await pull(b, localB)).length).toBe(150);
  });

  it('makes room when the 100 KB quota fills, dropping the oldest days', async () => {
    const mod = await on(localA);
    for (let day = 25; day >= 0; day--) {
      const list = Array.from({ length: 25 }, (_, i) => ({ id: `d${day}-${i}-${'y'.repeat(24)}`, p: 'a', t: Date.now() - day * 864e5 - i * MIN, type: 'meal', amount: 30, note: 'a fairly long note about the meal' }));
      expect(await mod.pushEvents({ upsert: list })).toBe(true);
    }
    expect(await sync.getBytesInUse()).toBeLessThanOrEqual(102400);
    const days = await mod.syncedDays();
    expect(days).toContain(new Date().toISOString().slice(0, 10));   // today always kept
    expect((await localA.get('syncError')).syncError).toBeUndefined();
  });

  it('records a sync failure for Settings instead of hiding it', async () => {
    const mod = await on(localA);
    sync.set = async () => { throw new Error('Sync is off'); };
    expect(await mod.pushEvents({ upsert: [dose('d1', 5)] })).toBe(false);
    expect((await localA.get('syncError')).syncError.message).toMatch(/Sync is off/);
  });

  it('never sends practice markers made on demo people', async () => {
    const mod = await on(localA);
    await mod.pushEvents({ upsert: [{ ...dose('x', 5), p: 'demo-1' }] });
    expect(Object.keys(sync.data()).filter((k) => k.startsWith('ev:'))).toEqual([]);
  });

  it('shared settings: the newer change of each setting wins, alert on/off and sound stay per computer', async () => {
    const mod = await on(localA);
    const t0 = 1_000;
    // A changed units at t0+10; B changed the low limit at t0+20 and has sound off.
    await mod.pushSettings({ units: 'mmol/L', alerts: { low: 70, enabled: true, sound: 'all' } }, { units: t0 + 10 });
    await mod.pushSettings({ units: 'mg/dL', alerts: { low: 80, enabled: false, sound: 'off' } }, { alerts: t0 + 20 });
    const shared = await mod.syncedShared();
    expect(shared.v.units).toBe('mmol/L');
    expect(shared.v.alerts.low).toBe(80);
    expect(shared.v.alerts.enabled).toBeUndefined();
    // A computer that was off since t0 takes both, keeps its own switch and sound.
    const merged = mod.mergeSettings({ units: 'mg/dL', alerts: { low: 70, enabled: true, sound: 'urgent' }, deviceName: 'Laptop' }, { units: t0 }, shared);
    expect(merged.settings.units).toBe('mmol/L');
    expect(merged.settings.alerts).toEqual({ low: 80, enabled: true, sound: 'urgent' });
    expect(merged.settings.deviceName).toBe('Laptop');
    // A local change newer than what sync holds is not undone.
    expect(mod.mergeSettings({ units: 'mg/dL' }, { units: t0 + 99 }, { v: { units: 'mmol/L' }, t: { units: t0 + 10 } })).toBeNull();
  });

  it('stamps only shared settings that changed', async () => {
    const mod = await on(localA);
    expect(mod.stampChanges({ units: 'mg/dL', deviceName: 'A' }, { units: 'mg/dL', deviceName: 'B' }, {}, 5)).toBeNull();
    expect(mod.stampChanges({ alerts: { low: 70, sound: 'all' } }, { alerts: { low: 70, sound: 'off' } }, {}, 5)).toBeNull();
    expect(mod.stampChanges({ alerts: { low: 70 } }, { alerts: { low: 75 } }, {}, 5)).toEqual({ alerts: 5 });
  });
});

describe('medicines and AI summary', () => {
  it('reads generic and brand insulin names', () => {
    expect(insulinKindFromName('insulin isophane, human 70 UNT/ML / insulin regular, human 30 UNT/ML Injectable Suspension')).toBe('mix');
    expect(insulinKindFromName('Humulin N')).toBe('intermediate');
    expect(insulinKindFromName('Humulin R U-500')).toBe('short');
    expect(insulinKindFromName('Lantus SoloStar')).toBe('basal');
    expect(insulinKindFromName('Fiasp')).toBe('rapid');
  });
  it('the AI summary carries no name and marks partial days, including today', () => {
    const now = Date.UTC(2026, 9, 1, 18);
    const points = [];
    for (let t = now - 3 * 864e5; t <= now; t += 5 * MIN) points.push({ t, mg: 120 });
    const s = buildSummary({ points, events: [], person: { pid: 'a', name: 'Kenneth Example', low: 70, high: 180 }, units: 'mg/dL', days: 3, now });
    expect(JSON.stringify(s)).not.toMatch(/Kenneth/);
    expect(s.daily.length).toBe(4);
    expect(s.daily[0].partialDay).toBe(true);
    expect(s.daily[s.daily.length - 1].partialDay).toBe(true);
    expect(s.daily[1].partialDay).toBeUndefined();
  });
});
