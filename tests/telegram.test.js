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
    async setChat(id, patch) { const c = chats.get(String(id)); if (!c?.active) return false; Object.assign(c, patch); return true; },
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

describe('the Telegram logbook', () => {
  let doses, mealCalls;
  function memDoses() {
    const rows = new Map();
    return {
      ready: true, rows,
      async recent(pid) { return [...rows.values()].filter((d) => !pid || d.pid === pid).sort((a, b) => b.t - a.t); },
      async upsert(list) { for (const d of list) rows.set(d.id, { ...d, t: new Date(d.t).getTime() }); return list.length; },
    };
  }
  const callL = (path, { body, headers = {} } = {}) => {
    const url = new URL(`https://cgm.test/${path}`);
    return telegramRoute(path, new Request(url, { method: 'POST', headers, body: JSON.stringify(body || {}) }), url, env, {
      store: tg, json, keyOk, snapshot, night, api: apiL, doses,
      meal: async (bot, dataUrl) => { mealCalls.push(dataUrl.slice(0, 30)); return { food: true, total: 48, low: 38, high: 60, items: [{ name: 'rice', carbs: 40 }], confidence: 'medium' }; },
      fetchImpl: async () => new Response(new Uint8Array([255, 216, 255, 224, 1, 2, 3]), { status: 200 }),
    });
  };
  const apiL = async (token, method, body) => { sent.push({ method, body }); if (method === 'getFile') return { file_path: 'photos/a.jpg' }; if (method === 'getMe') return { id: 42, username: 'su94r_alerts_bot' }; return { message_id: 900 }; };
  const say = (text, chatId = 1001) => callL('tg/webhook', { body: { message: { chat: { id: chatId }, text } }, headers: { 'X-Telegram-Bot-Api-Secret-Token': tg.bot_.webhook_secret } });
  const tap = (data, chatId = 1001) => callL('tg/webhook', { body: { callback_query: { id: 'c', data, message: { chat: { id: chatId }, message_id: 77 } } }, headers: { 'X-Telegram-Bot-Api-Secret-Token': tg.bot_.webhook_secret } });
  const lastSend = () => sent.filter((s) => s.method === 'sendMessage').at(-1)?.body;

  beforeEach(async () => {
    doses = memDoses();
    mealCalls = [];
    await call('tg/config', { query: '?key=owner', body: { token: TOKEN } });
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: { role: 'me' } })).json()).url), 1001);
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: { role: 'family' } })).json()).url), 5005, 'Mom');
    sent = [];
  });

  it('"4 R" asks first with Log it / Cancel, and logs only after Log it (once, even if tapped twice)', async () => {
    await say('4 R');
    const q = lastSend();
    expect(q.text).toBe('Log 4 units of regular insulin now?');
    const [logIt, cancel] = q.reply_markup.inline_keyboard[0];
    expect(cancel.callback_data).toBe('nolog');
    expect(doses.rows.size).toBe(0);
    await tap(logIt.callback_data);
    await tap(logIt.callback_data);
    expect(doses.rows.size).toBe(1);
    expect([...doses.rows.values()][0]).toMatchObject({ pid: 'p1', kind: 'short', amount: 4, source: 'telegram' });
    expect(sent.find((s) => s.method === 'editMessageText').body.text).toMatch(/^Logged 4 units of regular insulin at /);
  });

  it('warns about a recent dose before asking, and Cancel logs nothing', async () => {
    await doses.upsert([{ id: 'x', pid: 'p1', t: Date.now() - 40 * 60e3, kind: 'rapid', amount: 3, source: 'extension' }]);
    await say('4 units rapid');
    expect(lastSend().text).toMatch(/^Careful: You already logged 3 u rapid 40 min ago/);
    await tap('nolog');
    expect(doses.rows.size).toBe(1);
  });

  it('carbs by text; silly amounts refused; family chats cannot log', async () => {
    await say('40 g');
    expect(lastSend().text).toBe('Log 40 g of carbs now?');
    await say('900 g');
    expect(lastSend().text).toMatch(/not something I can log/);
    await say('4 R', 5005);
    expect(lastSend().text).toMatch(/This chat can't log yet: the owner can allow it in su94r Mini/);
    await tap(`log:c:40:${Math.round(Date.now() / 60e3)}`, 5005);
    expect(doses.rows.size).toBe(0);
  });

  it('a family chat logs once the owner allows it in su94r Mini', async () => {
    expect((await call('tg/chats/allow', { query: '?key=wrong', body: { chatId: '5005', canLog: true } })).status).toBe(401);
    expect((await call('tg/chats/allow', { query: '?key=owner', body: { chatId: '1001', canLog: true } })).status).toBe(404);   // the owner's own chat logs anyway
    expect(await (await call('tg/chats/allow', { query: '?key=owner', body: { chatId: '5005', canLog: true } })).json()).toEqual({ ok: true, canLog: true });
    const st = await (await call('tg/status', { method: 'GET', query: '?key=owner' })).json();
    expect(st.chats.find((c) => c.id === '5005')).toMatchObject({ role: 'family', canLog: true });
    await say('40 g', 5005);
    expect(lastSend().text).toBe('Log 40 g of carbs now?');
    await tap(`log:c:40:${Math.round(Date.now() / 60e3)}`, 5005);
    expect(doses.rows.size).toBe(1);
  });

  it('a chat in Spanish: Spanish words in, Spanish answers out; /english and /espanol switch', async () => {
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: { role: 'me' } })).json()).url), 7007, 'Ana');
    await callL('tg/webhook', { body: { message: { chat: { id: 7007 }, from: { language_code: 'es' }, text: '/espanol' } }, headers: { 'X-Telegram-Bot-Api-Secret-Token': tg.bot_.webhook_secret } });
    expect(lastSend().text).toMatch(/^Listo: su94r te escribe en español/);
    await say('cuatro unidades de rápida', 7007);
    const q = lastSend();
    expect(q.text).toBe('¿Registrar 4 unidades de insulina rápida ahora?');
    expect(q.reply_markup.inline_keyboard[0].map((b) => b.text)).toEqual(['Registrar', 'Cancelar']);
    await tap(q.reply_markup.inline_keyboard[0][0].callback_data, 7007);
    expect(sent.find((x) => x.method === 'editMessageText').body.text).toMatch(/^Registrado: 4 unidades de insulina rápida a las /);
    await say('comí cuarenta gramos', 7007);
    expect(lastSend().text).toBe('¿Registrar 40 g de carbohidratos ahora?');
    await say('/english', 7007);
    await say('/sugar', 7007);
    expect(lastSend().text).toMatch(/118 mg\/dL .*min ago|118 mg\/dL .*just now/);
  });

  it('alerts reach each chat in its own language, with its own "I\'m OK" button', async () => {
    tg.chats_.get('5005').lang = 'es';
    await tg.setEnabled(true);
    const n = await telegramAlert(tg, 'family', { title: 'Ken is low', message: 'Check on them.', es: { title: 'Ken tiene la glucosa baja', message: 'Revisa cómo está.' }, actions: [{ action: 'http', label: "I'm OK", url: 'https://x/night/ack?t=' + 'a'.repeat(32) }] }, { api: apiL });
    expect(n).toBe(1);
    const m = sent.filter((x) => x.method === 'sendMessage').at(-1).body;
    expect(m.text).toBe('Ken tiene la glucosa baja\nRevisa cómo está.');
    expect(m.reply_markup.inline_keyboard[0][0].text).toBe('Estoy bien');
  });

  it('a plate photo gets a carb estimate with a "Log 48 g" button; a caption with grams wins', async () => {
    await callL('tg/webhook', { body: { message: { chat: { id: 1001 }, photo: [{ file_id: 's', file_size: 1000 }, { file_id: 'b', file_size: 90000 }] } }, headers: { 'X-Telegram-Bot-Api-Secret-Token': tg.bot_.webhook_secret } });
    expect(mealCalls[0]).toBe('data:image/jpeg;base64,/9j/4AE');   // the photo, as a data URL
    expect(sent.find((s) => s.method === 'getFile').body.file_id).toBe('b');
    const r = lastSend();
    expect(r.text).toMatch(/^About 48 g of carbs \(likely 38–60 g, medium confidence\)\.\n• rice about 40 g\nPhoto estimates are rough/);
    expect(r.reply_markup.inline_keyboard[0][0].text).toBe('Log 48 g');
    await callL('tg/webhook', { body: { message: { chat: { id: 1001 }, caption: '35g', photo: [{ file_id: 'b', file_size: 900 }] } }, headers: { 'X-Telegram-Bot-Api-Secret-Token': tg.bot_.webhook_secret } });
    expect(mealCalls).toHaveLength(1);
    expect(lastSend().text).toBe('Log 35 g of carbs now?');
  });

  it('the proxy\'s proof check: only the proof derived from this bot\'s secret passes', async () => {
    const { mealProof } = await import('../workers/telegram.js');
    const good = await mealProof(tg.bot_);
    expect((await callL('tg/proof', { headers: { 'X-Su94r-Proof': good } })).status).toBe(200);
    expect((await callL('tg/proof', { headers: { 'X-Su94r-Proof': 'a'.repeat(64) } })).status).toBe(401);
    expect((await callL('tg/proof', {})).status).toBe(401);
  });
});

describe('the doctor visit pack on Telegram', () => {
  beforeEach(async () => {
    await call('tg/config', { query: '?key=owner', body: { token: TOKEN } });
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: { role: 'me' } })).json()).url), 1001);
    await startWith(codeOf((await (await call('tg/link/new', { query: '?key=owner', body: { role: 'family' } })).json()).url), 5005, 'Mom');
  });
  const pdf = Buffer.from('%PDF-1.4\n%fake report\n%%EOF\n').toString('base64');

  it('sends the report PDF to the owner\'s chats only; needs the key; PDFs only', async () => {
    const posts = [];
    const fetchImpl = async (url, init) => { posts.push({ url, form: init.body }); return new Response('{"ok":true}', { status: 200 }); };
    const doc = (query, body) => { const url = new URL(`https://cgm.test/tg/document${query}`); return telegramRoute('tg/document', new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, env, { store: tg, json, keyOk, snapshot, night, api, fetchImpl }); };
    expect((await doc('?key=wrong', { name: 'r.pdf', data: pdf })).status).toBe(401);
    expect((await doc('?key=owner', { name: 'r.pdf', data: Buffer.from('<html>').toString('base64') })).status).toBe(400);
    const r = await (await doc('?key=owner', { name: 'su94r report 1.pdf', data: pdf, caption: 'Glucose report' })).json();
    expect(r).toEqual({ ok: true, sent: 1 });
    expect(posts[0].url).toMatch(/\/sendDocument$/);
    expect(posts[0].form.get('chat_id')).toBe('1001');
    expect(posts[0].form.get('document').name).toBe('su94rreport1.pdf');
  });

  it('night/notify sends a plain message to ntfy and the owner\'s Telegram (owner key only)', async () => {
    const pushes = [];
    const url = (q) => new URL(`https://cgm.test/night/notify${q}`);
    const notify = (q, body) => nightRoute('night/notify', new Request(url(q), { method: 'POST', body: JSON.stringify(body) }), url(q), env, { store: night, json, keyOk, snapshot, push: async (topic, msg) => { pushes.push({ topic, ...msg }); }, telegram: (role, msg) => telegramAlert(tg, role, msg, { api }) });
    expect((await notify('?key=wrong', { title: 'x', message: 'y' })).status).toBe(401);
    sent = [];
    expect((await notify('?key=owner', { title: 'Your week', message: 'In range: 72%.' })).status).toBe(200);
    expect(pushes[0]).toMatchObject({ topic: 'su94r-self', title: 'Your week', message: 'In range: 72%.' });
    expect(sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.chat_id)).toEqual([1001]);
  });
});
