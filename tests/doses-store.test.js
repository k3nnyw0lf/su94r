// The dose store against PostgREST's real answers. What must hold: a save answered "201 Created"
// with an empty body (return=minimal) is a success, not a JSON error. This broke every dose
// exchange on 2026-10-02 as soon as su94r Mini had a dose to send.

import { describe, it, expect } from 'vitest';
import { doseStore } from '../workers/doses.js';

const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srk' };

describe('dose store', () => {
  it('a save answered 201 with no body succeeds', async () => {
    const calls = [];
    const store = doseStore(env, { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 201 }); } });
    const n = await store.upsert([{ id: 'd1', pid: 'p1', t: Date.now(), kind: 'rapid', amount: 3, source: 'extension' }]);
    expect(n).toBe(1);
    expect(calls[0].url).toBe('https://db.test/rest/v1/su94r_doses?on_conflict=id');
  });
  it('a deletion answered 204 succeeds, and a read still parses rows', async () => {
    const store = doseStore(env, {
      fetchImpl: async (url, init) => (init?.method === 'PATCH'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify([{ id: 'd1', pid: 'p1', t: new Date().toISOString(), kind: 'carbs', amount: 40, source: 'alexa', deleted: false }]), { status: 200 })),
    });
    await store.markDeleted(['d1']);
    const rows = await store.recent('p1');
    expect(rows[0]).toMatchObject({ id: 'd1', kind: 'carbs', amount: 40 });
  });
  it('an error answer is still an error', async () => {
    const store = doseStore(env, { fetchImpl: async () => new Response('{"message":"bad"}', { status: 400 }) });
    await expect(store.upsert([{ id: 'd1', pid: 'p1', t: Date.now(), kind: 'rapid', amount: 3, source: 'extension' }])).rejects.toThrow(/answered 400/);
  });
});
