// su94r Mini showing a su94r family (extension/screen.js): pairing by code, then the family's
// people (Dexcom or Libre through su94r) as su94r Mini's own people, with no password here.
import { describe, it, expect } from 'vitest';
import { pairStart, pairPoll, screenData, screenPeople, screenAccountId, ScreenError } from '../extension/screen.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const SERVER = 'https://su94r.test/';

function server({ claimAfter = 1, expired = false, gone = false, people = [] } = {}) {
  const calls = [];
  let polls = 0, handed = false;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization || null });
    if (u.pathname === '/pair/start') return json({ code: 'K7Q4MD', secret: 's3cret', expiresIn: 900 });
    if (u.pathname === '/pair/poll') {
      if (expired) return json({ status: 'expired' });
      if (++polls <= claimAfter) return json({ status: 'waiting', code: 'K7Q4MD' });
      if (handed) return json({ status: 'paired' });
      handed = true;
      return json({ status: 'paired', token: 'tok-abc', name: 'Computer' });
    }
    if (u.pathname === '/screen/data') return gone ? json({ error: 'unauthorized' }, 401) : json({ at: Date.now(), people, screen: { name: 'Computer', kind: 'screen' } });
    return json({}, 404);
  };
  return { calls, fetchImpl };
}

describe('su94r Mini pairs as a family screen', () => {
  it('asks for a code as a screen, waits, then gets the token once', async () => {
    const s = server({ claimAfter: 1 });
    const pair = await pairStart(SERVER, s.fetchImpl);
    expect(pair).toEqual({ code: 'K7Q4MD', secret: 's3cret', expiresIn: 900 });
    expect(s.calls[0]).toMatchObject({ path: '/pair/start', method: 'POST', body: { kind: 'screen' } });
    expect(await pairPoll(SERVER, pair.secret, s.fetchImpl)).toEqual({ status: 'waiting' });
    expect(await pairPoll(SERVER, pair.secret, s.fetchImpl)).toEqual({ status: 'paired', token: 'tok-abc', name: 'Computer' });
    expect(s.calls[1].body).toEqual({ secret: 's3cret' });
    // The token is handed over once: a later look cannot get it again.
    expect(await pairPoll(SERVER, pair.secret, s.fetchImpl)).toEqual({ status: 'expired' });
    expect(await pairPoll(SERVER, 'x', server({ expired: true }).fetchImpl)).toEqual({ status: 'expired' });
  });

  it('reads the family with its own token; a removed screen is "auth", no network is "net"', async () => {
    const s = server({ people: [] });
    await screenData(SERVER, 'tok-abc', s.fetchImpl);
    expect(s.calls[0]).toMatchObject({ path: '/screen/data', auth: 'Bearer tok-abc' });
    await expect(screenData(SERVER, 'tok-abc', server({ gone: true }).fetchImpl)).rejects.toMatchObject({ code: 'auth' });
    await expect(screenData(SERVER, 'tok-abc', async () => { throw new TypeError('Failed to fetch'); })).rejects.toBeInstanceOf(ScreenError);
    await expect(screenData(SERVER, 'tok-abc', async () => { throw new TypeError('Failed to fetch'); })).rejects.toMatchObject({ code: 'net' });
  });

  it('turns the family into su94r Mini people: stable ids, the doctor\'s range, clean points', async () => {
    const now = Date.now();
    const acc = { id: await screenAccountId('tok-abc') };
    expect(acc.id).toMatch(/^su94r-[0-9a-f]{12}$/);
    expect(acc.id).not.toContain('tok');
    expect(await screenAccountId('tok-abc')).toBe(acc.id);
    const people = screenPeople(acc, { people: [
      { name: 'Sofia', units: 'mg/dL', low: 80, high: 250, latest: { t: now - 60e3, mg: 223.4, trend: 2 },
        history: [[now - 20 * 3600e3, 140], [now - 10 * 60e3, 0], ['bad', 120], [now - 5 * 60e3, 230]] },
      { name: '', units: 'mmol/L', low: 3, high: 999, latest: { t: now, mg: 100, trend: 0 }, history: [] },
    ] });
    expect(people[0]).toEqual({
      pid: `${acc.id}-0`, name: 'Sofia', units: 'mg/dL', low: 80, high: 250,
      latest: { t: now - 60e3, mg: 223, trend: 2 },
      history: [{ t: now - 20 * 3600e3, mg: 140, trend: null }, { t: now - 5 * 60e3, mg: 230, trend: null }],
    });
    expect(people[1]).toMatchObject({ pid: `${acc.id}-1`, name: 'Unnamed', units: 'mmol/L', low: 70, high: 180, latest: { mg: 100, trend: null } });
    expect(screenPeople(acc, null)).toEqual([]);
  });
});
