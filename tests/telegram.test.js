// Low alerts on Telegram (workers/telegram.js). What must hold: only the owner sets up the bot,
// links chats and sees them; the token is checked with Telegram, never returned; a chat links
// only by pressing Start on a fresh one-time link; Telegram's calls need the secret header;
// strangers get nothing; alerts reach chats of the right role with an "I'm OK" button that
// acknowledges the low; /sugar answers linked chats; /stop unlinks; paused means silent.

import { describe, it, expect, beforeEach } from 'vitest';
import { telegramRoute, telegramAlert } from '../workers/telegram.js';
import { nightRoute, NIGHT_DEFAULTS } from '../workers/night.js';

const TOKEN = '123456789:' + 'A'.repeat(35);

function memTg() {
  let bot = null;
  const chats = new Map();
  const links = new Map();
  return {
    ready: true, chats_: chats, links_: links, get bot_() { return bot; },
    async bot() { return bot && { ...bot }; },
    async saveBot(row) { bot = { ...bot, ...row }; },
    async setEnabled(enabled) { bot.enabled = enabled; },
    async chats(role = null) { return [...chats.values()].filter((c) => c.active && (!role || c.role === role)); },
    async chat(id) { const c = chats.get(String(id)); return c?.active ? c : null; },
    async linkChat(row) { chats.set(String(row.chat_id), { ...row, active: true, linked_at: new Date().toISOString() }); },
    async unlink(id) { const c = chats.get(String(id)); if (c) c.active = false; },
    async newLink(h, role) { links.set(h, { code_hash: h, role, expires_at: Date.now() + 15 * 60e3 }); },
    async takeLink(h) { const l = links.get(h); links.delete(h); return l && l.expires_at > Date.now() ? l : null; },
    async sweepLinks() {},
  };
}

let tg, sent, keyOk, night;
const api = async (token, method, body) => {
  sent.push({ token, method, body });
  if (method === 'getMe') { if (token !== TOKEN) throw new Error('Unauthorized'); return { id: 42, username: 'su94r_alerts_bot' }; }
  return true;
};
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const env = { SUPABASE_URL: 'https://db.test' };
const snapshot = async () => ({ people: [{ pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', latest: { t: Date.now() - 60e3, mg: 118, trend: 3 } }] });
const call = (path, { method = 'POST', body, query = '', headers = {} } = {}) => {
  const url = new URL(`https://cgm.test/${path}${query}`);
  return telegramRoute(path, new Request(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) }), url, env, { store: tg, json, keyOk, snapshot, night, api });
};
const fromTelegram = (update, secret) => call('tg/webhook', { body: update, headers: { 'X-Telegram-Bot-Api-Secret-Token': secret ?? tg.bot_.webhook_secret } });
const startWith = async (code, chatId = 1001, first = 'Ken') => fromTelegram({ message: { chat: { id: chatId }, from: { first_name: first }, text: `/start ${code}` } });
const codeOf = (url) => new URL(url).searchParams.get('start');

function memNight() {
  let row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 'su94r-self', care_topic: 'su94r-care', state: {} };
  return { ready: true, get row() { return row; }, async get() { return structuredClone(row); }, async patch(f) { Object.assign(row, structuredClone(f)); }, async claimTick() { return true; } };
}

beforeEach(() => {
  tg = memTg();
  sent = [];
  night = memNight();
  keyOk = async (k) => k === 'owner';
});

describe('setting up the su94r bot', () => {
  it('only the owner; the token is checked with Telegram, the bot is pointed here with a secret, and the token never comes back', async () => {
    expect((await call('tg/config', { query: '?key=wrong', body: { token: TOKEN } })).status).toBe(401);
    expect((await call('tg/config', { query: '?key=owner', body: { token: 'nonsense' } })).status).toBe(400);
    expect((await call('tg/config', { query: '?key=owner', body: { token: '987654321:' + 'B'.repeat(35) } })).status).toBe(400);   // Telegram says no
    const r = await (await call('tg/config', { query: '?key=owner', body: { token: TOKEN } })).json();
    expect(r).toEqual({ ok: true, bot: '@su94r_alerts_bot' });
    const hook = sent.find((s) => s.method === 'setWebhook').body;
    expect(hook.url).toBe('https://db.test/functions/v1/su94r-cgm/tg/webhook');
    expect(hook.secret_token).toMatch(/^[0-9a-f]{48}$/);
    expect(hook.secret_token).toBe(tg.bot_.webhook_secret);
    const status = await (await call('tg/status', { method: 'GET', query: '?key=owner' })).json();
    expect(status).toMatchObject({ configured: true, bot: '@su94r_alerts_bot', enabled: true, chats: [] });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });
});

describe('linking a chat by pressing Start', () => {
  beforeEach(async () => { await call('tg/config', { query: '?key=owner', body: { token: TOKEN } }); sent = []; });

  it('a fresh one-time link plus Start links the chat, once', async () => {
    const link = await (await call('tg/link/new', { query: '?key=owner', body: { role: 'me' } })).json();
    expect(link.url).toMatch(/^https:\/\/t\.me\/su94r_alerts_bot\?start=[0-9a-f]{32}$/);
    expect(JSON.stringify([...tg.links_.keys()])).not.toContain(codeOf(link.url));     // only its hash is kept
    await startWith(codeOf(link.url));
    expect(await tg.chat(1001)).toMatchObject({ role: 'me', name: 'Ken' });
    expect(sent.at(-1).body.text).toMatch(/^Linked to su94r\./);
    await startWith(codeOf(link.url), 2002, 'Other');
    expect(await tg.chat(2002)).toBeNull();
    expect(sent.at(-1).body.text).toMatch(/expired or was already used/);
  });

  it('Telegram\'s calls need the secret header; strangers get nothing', async () => {
    expect((await fromTelegram({ message: { chat: { id: 1 }, text: '/sugar' } }, 'wrong')).status).toBe(401);
    sent = [];
    await fromTelegram({ message: { chat: { id: 3003 }, text: '/sugar' } });
    expect(sent).toEqual([]);
  });

  it('/sugar answers a linked chat; /stop unlinks it; the owner can remove a chat', async () => {
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: { role: 'family' } })).json()).url));
    await fromTelegram({ message: { chat: { id: 1001 }, text: '/sugar' } });
    expect(sent.at(-1).body.text).toBe('118 mg/dL → (1 min ago)');
    await fromTelegram({ message: { chat: { id: 1001 }, text: '/stop' } });
    expect(await tg.chat(1001)).toBeNull();
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: {} })).json()).url), 4004);
    expect((await (await call('tg/status', { method: 'GET', query: '?key=owner' })).json()).chats.map((c) => c.id)).toEqual(['4004']);
    await call('tg/chats/remove', { query: '?key=owner', body: { chatId: '4004' } });
    expect(await tg.chat(4004)).toBeNull();
  });
});

describe('alerts on Telegram', () => {
  beforeEach(async () => {
    await call('tg/config', { query: '?key=owner', body: { token: TOKEN } });
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: { role: 'me' } })).json()).url), 1001);
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: { role: 'family' } })).json()).url), 5005, 'Mom');
    sent = [];
  });

  it('a low goes to the owner\'s chats with an "I\'m OK" button that acknowledges it', async () => {
    const url = new URL('https://cgm.test/night/tick');
    const lowSnap = async () => ({ people: [{ pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', latest: { t: Date.now() - 60e3, mg: 62, trend: 3 } }] });
    const ntfy = async () => true;
    await nightRoute('night/tick', new Request(url, { method: 'POST' }), url, env, { store: night, json, keyOk, snapshot: lowSnap, push: ntfy, telegram: (role, msg) => telegramAlert(tg, role, msg, { api }) });
    const msg = sent.find((s) => s.method === 'sendMessage');
    expect(msg.body.chat_id).toBe(1001);
    expect(msg.body.text).toMatch(/^Low: 62 mg\/dL/);
    const button = msg.body.reply_markup.inline_keyboard[0][0];
    expect(button.text).toBe("I'm OK");
    expect(sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.chat_id)).not.toContain(5005);   // family not told yet
    await fromTelegram({ callback_query: { id: 'cq1', data: button.callback_data, message: { chat: { id: 1001 }, message_id: 7 } } });
    expect(night.row.state.p1.ackAt).toBeTruthy();
    expect(sent.find((s) => s.method === 'answerCallbackQuery').body.text).toMatch(/^Got it/);
  });

  it('when ntfy fails, Telegram alone still counts as sent; paused or no bot sends nothing', async () => {
    const url = new URL('https://cgm.test/night/test?key=owner');
    const failing = async () => { throw new Error('ntfy down'); };
    const r = await nightRoute('night/test', new Request(url, { method: 'POST' }), url, env, { store: night, json, keyOk, snapshot, push: failing, telegram: (role, msg) => telegramAlert(tg, role, msg, { api }) });
    expect(r.status).toBe(200);
    await call('tg/enabled', { query: '?key=owner', body: { enabled: false } });
    sent = [];
    expect(await telegramAlert(tg, 'me', { title: 'x' }, { api })).toBe(0);
    expect(sent).toEqual([]);
  });
});
