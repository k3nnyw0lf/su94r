// su94r as a connector for AI apps that speak MCP (Model Context Protocol): Claude
// (Settings → Connectors → Add custom connector) and ChatGPT developer mode. Read-only tools
// over the live glucose, the last 12 hours and the insulin logged in su94r Mini or said to Alexa.
//
// Address: https://<your su94r server>/mcp/<token>. su94r Mini makes the token (POST mcp/new
// with the display key); it is stored like a paired screen (kind 'ai'), so it shows in the
// same list and is removed the same way. Streamable HTTP, stateless: each POST is one
// JSON-RPC message answered with JSON.

import { randomToken, sha256 } from './screens.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Read-only glucose and insulin data from su94r (FreeStyle Libre via LibreLinkUp). '
  + 'Readings are mg/dL unless noted. Explain patterns and answer questions; do not give insulin dosing instructions, '
  + 'and suggest the person talk to their care team about changes to treatment.';

export const TOOLS = [
  {
    name: 'glucose_now',
    description: 'Current glucose for each person su94r follows: value, trend arrow, minutes since the reading, target range and units.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: 'Glucose now' },
  },
  {
    name: 'glucose_history',
    description: 'Glucose readings for the last 1 to 12 hours (about every 15 minutes, plus the latest), with average, lowest, highest and time in range.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', minimum: 1, maximum: 12, description: 'How many hours back (default 6).' },
        person: { type: 'string', description: 'First name of the person, when su94r follows more than one.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, title: 'Glucose history' },
  },
  {
    name: 'insulin_doses',
    description: 'Insulin doses logged in su94r Mini or said to Alexa in the last 1 to 48 hours: time, units, insulin type and where it was logged.',
    inputSchema: {
      type: 'object',
      properties: { hours: { type: 'number', minimum: 1, maximum: 48, description: 'How many hours back (default 24).' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, title: 'Insulin doses' },
  },
];

const KIND_WORD = { rapid: 'rapid-acting', short: 'regular', intermediate: 'NPH', basal: 'long-acting', mix: 'pre-mixed' };
const ARROW = ['', 'falling fast', 'falling', 'steady', 'rising', 'rising fast'];
const iso = (t) => new Date(t).toISOString();

async function callTool(name, args, { snapshot, doses }) {
  if (name === 'glucose_now') {
    const snap = await snapshot();
    return snap.people.map((p) => ({
      person: p.firstName || p.name,
      glucose_mg_dl: p.latest?.mg ?? null,
      units_shown_to_person: p.units,
      trend: ARROW[p.latest?.trend] || 'unknown',
      reading_time: p.latest ? iso(p.latest.t) : null,
      minutes_ago: p.latest ? Math.round((Date.now() - p.latest.t) / 60e3) : null,
      target_range_mg_dl: [p.low, p.high],
    }));
  }
  if (name === 'glucose_history') {
    const hours = Math.min(12, Math.max(1, Number(args?.hours) || 6));
    const snap = await snapshot();
    const want = String(args?.person || '').toLowerCase();
    const people = want ? snap.people.filter((p) => (p.firstName || p.name).toLowerCase().startsWith(want)) : snap.people;
    return people.map((p) => {
      const pts = p.history.filter((q) => q.t >= Date.now() - hours * 3600e3);
      const mgs = pts.map((q) => q.mg);
      const inRange = mgs.filter((v) => v >= p.low && v <= p.high).length;
      return {
        person: p.firstName || p.name,
        hours,
        readings: pts.map((q) => ({ time: iso(q.t), mg_dl: q.mg })),
        average_mg_dl: mgs.length ? Math.round(mgs.reduce((a, b) => a + b, 0) / mgs.length) : null,
        lowest_mg_dl: mgs.length ? Math.min(...mgs) : null,
        highest_mg_dl: mgs.length ? Math.max(...mgs) : null,
        time_in_range_percent: mgs.length ? Math.round((100 * inRange) / mgs.length) : null,
        target_range_mg_dl: [p.low, p.high],
      };
    });
  }
  if (name === 'insulin_doses') {
    const hours = Math.min(48, Math.max(1, Number(args?.hours) || 24));
    const snap = await snapshot().catch(() => ({ people: [] }));
    const nameOf = Object.fromEntries(snap.people.map((p) => [p.pid, p.firstName || p.name]));
    const list = (await doses()).filter((d) => d.t >= Date.now() - hours * 3600e3);
    return list.map((d) => ({
      person: nameOf[d.pid] || 'someone followed',
      time: iso(d.t), units: d.amount, insulin: KIND_WORD[d.kind] || d.kind,
      logged_by: d.source === 'alexa' ? 'Alexa' : 'su94r Mini',
    }));
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpc: -32602 });
}

/** One JSON-RPC message → the reply object, or null for a notification. */
export async function handleRpc(msg, deps) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  if (msg.id === undefined) return null;   // a notification (e.g. notifications/initialized)
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'su94r', title: 'su94r glucose', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const data = await callTool(msg.params?.name, msg.params?.arguments || {}, deps);
        return reply({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: { result: data }, isError: false });
      } catch (e) {
        if (e.rpc) return fail(e.rpc, e.message);
        return reply({ content: [{ type: 'text', text: `su94r could not get that: ${e.message}` }], isError: true });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/**
 * Routes mcp/new (display key: makes a token) and mcp/<token> (the connector itself).
 * Returns null when the path is not an MCP route.
 */
export async function mcpRoute(path, request, url, env, { screens, json, keyOk, snapshot, doses }) {
  const parts = path.split('/');
  if (parts[0] !== 'mcp') return null;
  if (!screens.ready) return json({ error: 'not configured' }, 503);
  if (path === 'mcp/new') {
    if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const { name } = await request.json().catch(() => ({}));
    const token = randomToken();
    const label = String(name || 'AI connector').replace(/[^\p{L}\p{N} '.-]/gu, '').trim().slice(0, 40) || 'AI connector';
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await screens.insert({ id, secret_hash: await sha256(randomToken()), token_hash: await sha256(token), kind: 'ai', name: label, expires_at: now, claimed_at: now });
    return json({ id, token, name: label });
  }
  // The connector: token in the path, or as a bearer header (for apps that set one).
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const token = /^[0-9a-f]{64}$/.test(parts[1] || '') ? parts[1] : auth;
  const row = /^[0-9a-f]{64}$/.test(token) ? await screens.byToken(await sha256(token)) : null;
  if (!row || row.kind !== 'ai') return json({ error: 'unauthorized' }, 401);
  if (!row.last_seen || Date.now() - Date.parse(row.last_seen) > 60e3) screens.update(row.id, { last_seen: new Date().toISOString() }).catch(() => {});
  if (request.method === 'GET') return json({ error: 'This server does not stream; POST JSON-RPC messages.' }, 405, { Allow: 'POST' });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const deps = { snapshot, doses };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(m, deps)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleRpc(body, deps);
  return out ? json(out) : new Response(null, { status: 202 });
}
