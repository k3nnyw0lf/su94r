// Dexcom Share (workers/dexcom.js): sign-in in two steps, readings, trends, and the errors that
// must stop retries (bad password, a locked account).
import { describe, it, expect } from 'vitest';
import { dexcomLogin, dexcomReadings, dexcomTrend, dexcomTime, DEXCOM_APP_ID, DexcomError } from '../workers/dexcom.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function share({ password = 'right', readings = [], lockAfter = Infinity } = {}) {
  const calls = [];
  let fails = 0;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ path: u.pathname, search: u.search, body });
    if (u.pathname.endsWith('/General/AuthenticatePublisherAccount')) {
      if (fails >= lockAfter) return json({ Code: 'SSO_AuthenticateMaxAttemptsExceeded', Message: 'Maximum authentication attempts exceeded' }, 500);
      if (body.password !== password) { fails++; return json({ Code: 'AccountPasswordInvalid', Message: 'Account password is not valid' }, 500); }
      return json('acc-1234');
    }
    if (u.pathname.endsWith('/General/LoginPublisherAccountById')) return json(body.accountId === 'acc-1234' ? 'sess-5678' : '00000000-0000-0000-0000-000000000000');
    if (u.pathname.endsWith('/Publisher/ReadPublisherLatestGlucoseValues')) {
      if (u.searchParams.get('sessionId') !== 'sess-5678') return json({ Code: 'SessionIdNotFound', Message: 'Session ID not found' }, 500);
      return json(readings);
    }
    return json({}, 404);
  };
  return { calls, fetchImpl };
}

describe('Dexcom Share', () => {
  it('maps every trend, by name and by the old numbers, to su94r\'s arrows', () => {
    expect(['DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat', 'FortyFiveDown', 'SingleDown', 'DoubleDown', 'NotComputable', 'RateOutOfRange', 'None'].map(dexcomTrend)).toEqual([5, 5, 4, 3, 2, 1, 1, 0, 0, 0]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(dexcomTrend)).toEqual([5, 5, 4, 3, 2, 1, 1, 0, 0, 0]);
    expect(dexcomTime('Date(1792363000000)')).toBe(1792363000000);
    expect(dexcomTime('/Date(1792363000000-0400)/')).toBe(1792363000000);
    expect(Number.isNaN(dexcomTime('nope'))).toBe(true);
  });

  it('signs in with the account id, then the session; reads, sorts and cleans the readings', async () => {
    const s = share({ readings: [
      { WT: 'Date(1792363600000)', Value: 64, Trend: 'SingleDown' },
      { WT: 'Date(1792363300000)', Value: 72, Trend: 'FortyFiveDown' },
      { WT: 'Date(1792363000000)', Value: 0, Trend: 'Flat' },          // a gap marker: dropped
    ] });
    const session = await dexcomLogin('parent@example.test', 'right', { fetchImpl: s.fetchImpl });
    expect(session).toMatchObject({ host: 'share2.dexcom.com', sessionId: 'sess-5678' });
    expect(s.calls[0].body).toEqual({ accountName: 'parent@example.test', password: 'right', applicationId: DEXCOM_APP_ID });
    expect(s.calls[1].body).toEqual({ accountId: 'acc-1234', password: 'right', applicationId: DEXCOM_APP_ID });
    const pts = await dexcomReadings(session, { fetchImpl: s.fetchImpl });
    expect(pts).toEqual([{ t: 1792363300000, mg: 72, trend: 2 }, { t: 1792363600000, mg: 64, trend: 1 }]);
    expect(s.calls[2].search).toMatch(/minutes=720&maxCount=144/);
    const ous = await dexcomLogin('p', 'right', { region: 'ous', fetchImpl: share().fetchImpl });
    expect(ous.host).toBe('shareous1.dexcom.com');
  });

  it('a wrong password is "credentials", too many tries is "locked", an ended session is "auth"', async () => {
    const s = share({ lockAfter: 2 });
    await expect(dexcomLogin('p', 'wrong', { fetchImpl: s.fetchImpl })).rejects.toMatchObject({ code: 'credentials' });
    await expect(dexcomLogin('p', 'wrong', { fetchImpl: s.fetchImpl })).rejects.toMatchObject({ code: 'credentials' });
    await expect(dexcomLogin('p', 'right', { fetchImpl: s.fetchImpl })).rejects.toMatchObject({ code: 'locked' });
    await expect(dexcomReadings({ host: 'share2.dexcom.com', sessionId: 'old' }, { fetchImpl: share().fetchImpl })).rejects.toMatchObject({ code: 'auth' });
    await expect(dexcomReadings({ host: 'evil.test', sessionId: 'sess-5678' }, { fetchImpl: share().fetchImpl })).rejects.toBeInstanceOf(DexcomError);
    await expect(dexcomLogin('', '', { fetchImpl: share().fetchImpl })).rejects.toMatchObject({ code: 'credentials' });
  });
});
