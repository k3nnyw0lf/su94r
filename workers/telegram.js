// Low alerts on Telegram, linked by a tap: the su94r bot sends the same alerts as ntfy (with an
// "I'm OK" button) to the chats that linked themselves.
//
// The rebuild after the 2026-09-04 Telegram pause: ONE bot made for su94r, its token in ONE place
// (table su94r_telegram_bot, pasted by the owner into su94r Mini, sent only to this server and
// never returned by any route), ONE sender (this file), ONE chat table. Nothing sends until a
// bot is set up, and the owner can pause it.
//
// Linking: su94r Mini (owner key) or a shared phone asks for a one-time link; it opens
// https://t.me/<bot>?start=<code>; pressing Start in Telegram sends "/start <code>" to the bot,
// which links that chat (once, within 15 minutes). Chats that never linked get nothing back.
//
// Tables (migration 20261002h_su94r_telegram.sql), service role only.
//
// Routes:
//   GET  tg/status?key=<owner>          bot name, on/off, linked chats
//   POST tg/config?key=<owner>          { token } checks it with Telegram, points the bot here
//   POST tg/link/new?key=<owner>        { role } → { url, expiresIn }
//   POST tg/chats/remove?key=<owner>    { chatId }
//   POST tg/enabled?key=<owner>         { enabled }
//   POST tg/test?key=<owner>            a test message to the owner's chats
//   POST tg/webhook                     Telegram itself (its secret header must match)

import { sha256, randomToken } from './screens.js';
import { acknowledge } from './night.js';
import { parseLog, describeLog, entryFromData, MEAL_PROMPT, parseMealAnswer, describeMeal } from './tglog.js';
import { asMarkers } from './doses.js';
import { doubleDoseWarning } from '../extension/insulin.js';

const DEFAULT_PROXY = 'https://su94r-proxy.ken-e90.workers.dev';
const MAX_PHOTO_BYTES = 1500 * 1024;

/** The proof su94r-cgm hands the proxy for a meal photo (the proxy asks tg/proof to check it). */
export const mealProof = (bot) => sha256(`${bot.webhook_secret}:meal`);

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Downloads a Telegram photo (the largest size under the limit) as a data: URL. */
async function photoDataUrl(bot, photos, { api, fetchImpl }) {
  const pick = [...photos].sort((a, b) => (b.file_size || 0) - (a.file_size || 0)).find((p) => (p.file_size || 0) <= MAX_PHOTO_BYTES);
  if (!pick) return null;
  const file = await api(bot.token, 'getFile', { file_id: pick.file_id });
  const res = await fetchImpl(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PHOTO_BYTES) return null;
  return `data:image/jpeg;base64,${base64(buf)}`;
}

/** Asks the proxy's Workers AI for a carb estimate; returns the parsed estimate or null. */
export async function askMeal(env, bot, dataUrl, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const res = await fetchImpl(`${(env.PROXY_URL || DEFAULT_PROXY).replace(/\/$/, '')}/ai/meal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Su94r-Proof': await mealProof(bot) },
    body: JSON.stringify({ image: dataUrl, prompt: MEAL_PROMPT }),
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => ({}));
  return parseMealAnswer(j.text);
}

const LINK_TTL_MS = 15 * 60e3;
const TG = 'https://api.telegram.org';

export function telegramStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const root = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(root && key);
  async function call(table, path, init = {}) {
    if (!ready) throw Object.assign(new Error('Telegram is not configured'), { code: 'config' });
    const res = await fetchImpl(`${root}/${table}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Telegram store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  return {
    ready,
    bot: async () => (await call('su94r_telegram_bot', '?select=*&id=eq.1'))[0] || null,
    saveBot: (row) => call('su94r_telegram_bot', '?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ id: 1, ...row, updated_at: new Date().toISOString() }) }),
    setEnabled: (enabled) => call('su94r_telegram_bot', '?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ enabled, updated_at: new Date().toISOString() }) }),
    chats: async (role = null) => call('su94r_telegram_chats', `?select=*&active=is.true${role ? `&role=eq.${q(role)}` : ''}&order=linked_at.asc`),
    chat: async (id) => (await call('su94r_telegram_chats', `?select=*&chat_id=eq.${q(id)}&active=is.true`))[0] || null,
    linkChat: (row) => call('su94r_telegram_chats', '?on_conflict=chat_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ ...row, active: true, linked_at: new Date().toISOString() }) }),
    unlink: (id) => call('su94r_telegram_chats', `?chat_id=eq.${q(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ active: false }) }),
    newLink: (codeHash, role) => call('su94r_telegram_links', '', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ code_hash: codeHash, role, expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString() }) }),
    /** Takes a link once: deleted on use, only while it is fresh. */
    takeLink: async (codeHash) => (await call('su94r_telegram_links', `?code_hash=eq.${q(codeHash)}&expires_at=gt.${q(new Date().toISOString())}`, { method: 'DELETE' }))[0] || null,
    sweepLinks: () => call('su94r_telegram_links', `?expires_at=lt.${q(new Date().toISOString())}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  };
}

export async function tgApi(token, method, body, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const res = await fetchImpl(`${TG}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw Object.assign(new Error(`Telegram ${method}: ${j.description || res.status}`), { status: res.status });
  return j.result;
}

const TOKEN_SHAPE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const ackTokenOf = (msg) => {
  const url = msg?.actions?.find((a) => a.action === 'http' && /night\/ack\?t=/.test(a.url))?.url;
  return url ? new URL(url).searchParams.get('t') : null;
};

/**
 * Sends a night alert to every linked chat of a role ('me' or 'family'). Returns how many got
 * it (0 when Telegram is not set up, paused, or nobody linked: that does not count as sent).
 */
export async function telegramAlert(store, role, msg, { api = tgApi } = {}) {
  if (!store.ready) return 0;
  const bot = await store.bot();
  if (!bot?.token || !bot.enabled) return 0;
  const chats = await store.chats(role);
  const ack = ackTokenOf(msg);
  let n = 0;
  for (const c of chats) {
    try {
      await api(bot.token, 'sendMessage', {
        chat_id: c.chat_id,
        text: [msg.title, msg.message].filter(Boolean).join('\n'),
        ...(ack ? { reply_markup: { inline_keyboard: [[{ text: "I'm OK", callback_data: `ack:${ack}` }]] } } : {}),
        disable_web_page_preview: true,
      });
      n++;
    } catch { /* one chat failing (blocked the bot) must not stop the others */ }
  }
  return n;
}

const clean = (s, max = 40) => String(s || '').replace(/[^\p{L}\p{N} '._-]/gu, '').trim().slice(0, max);
const nameOf = (from) => clean([from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'Telegram');

function sugarText(snap) {
  const people = snap?.people || [];
  if (!people.length) return 'No one is sharing their glucose with this account yet.';
  const arrows = ['', '↓', '↘', '→', '↗', '↑'];
  return people.map((p) => {
    const l = p.latest;
    if (!l) return `${p.firstName || p.name}: no reading yet`;
    const mins = Math.max(0, Math.round((Date.now() - l.t) / 60e3));
    const v = p.units === 'mmol/L' ? `${(l.mg / 18.0182).toFixed(1)} mmol/L` : `${Math.round(l.mg)} mg/dL`;
    return `${people.length > 1 ? `${p.firstName || p.name}: ` : ''}${l.mg < 40 ? 'LO' : v} ${arrows[l.trend] || ''} (${mins < 1 ? 'just now' : `${mins} min ago`})`.replace(/\s+\(/, ' (');
  }).join('\n');
}

/** Handles Telegram's own calls (the bot's webhook). */
async function webhook(request, store, { api, snapshot, night, doses, meal, fetchImpl }) {
  const bot = await store.bot();
  if (!bot?.token || !bot.webhook_secret) return { status: 404 };
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== bot.webhook_secret) return { status: 401 };
  const u = await request.json().catch(() => ({}));
  const say = (chatId, text, extra = {}) => api(bot.token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra }).catch(() => {});

  if (u.callback_query) {
    const cq = u.callback_query;
    const chatId = cq.message?.chat?.id;
    const linked = chatId != null && await store.chat(chatId);
    const data = String(cq.data || '');
    // "Log it" / "Cancel" under a logbook question.
    if (data === 'nolog' || data.startsWith('log:')) {
      let text = 'This chat is not linked to su94r.';
      let done = null;
      if (linked && linked.role === 'me' && data === 'nolog') { text = 'Not logged.'; done = 'Not logged.'; }
      else if (linked && linked.role === 'me') {
        const entry = entryFromData(data);
        const pid = await firstPerson(snapshot, doses);
        if (!entry || !pid || !doses?.ready) text = 'That can no longer be logged. Send it again.';
        else {
          try {
            // The same question answered twice logs once: the id comes from the question.
            await doses.upsert([{ id: `tg-${chatId}-${cq.message.message_id}`, pid, t: entry.t, kind: entry.kind, amount: entry.amount, source: 'telegram' }]);
            text = 'Logged.';
            done = `Logged ${entry.label} at ${new Date(entry.t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}. It shows in su94r Mini within a minute.`;
          } catch { text = 'Could not save it just now. Nothing was logged.'; }
        }
      } else if (linked) text = 'Only the owner\'s own chats can log.';
      await api(bot.token, 'answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
      if (done) await api(bot.token, 'editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: done }).catch(() => {});
      return { status: 200 };
    }
    const m = /^ack:([0-9a-f]{32})$/.exec(data);
    let text = 'This chat is not linked to su94r.';
    if (linked && m && night?.ready) {
      const row = await night.get();
      const state = await acknowledge(row, m[1]);
      if (state) { await night.patch({ state }); text = "Got it. Reminders for this low stop; a severe low still tells you once."; }
      else text = 'That alert was already answered, or the low is over.';
      await api(bot.token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    }
    await api(bot.token, 'answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
    return { status: 200 };
  }

  const msg = u.message;
  if (!msg?.chat?.id) return { status: 200 };
  const chatId = msg.chat.id;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const linkedChat = await store.chat(chatId);
    if (!linkedChat) return { status: 200 };                 // strangers get nothing
    const typed = parseLog(msg.caption || '');                 // "40 g" written under the photo wins
    if (typed) return askToLog(chatId, linkedChat, typed);
    await api(bot.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    let estimate = null;
    try {
      const dataUrl = await photoDataUrl(bot, msg.photo, { api, fetchImpl });
      estimate = dataUrl && meal ? await meal(bot, dataUrl) : null;
    } catch { estimate = null; }
    const d = describeMeal(estimate);
    if (d.total > 0 && linkedChat.role === 'me') {
      const q = describeLog({ type: 'carbs', grams: d.total, back: null });
      await say(chatId, d.text, { reply_markup: { inline_keyboard: [[{ text: `Log ${d.total} g`, callback_data: q.data }, { text: 'Cancel', callback_data: 'nolog' }]] } });
    } else {
      await say(chatId, d.text);
    }
    return { status: 200 };
  }
  if (typeof msg.text !== 'string') return { status: 200 };
  const [cmd, arg] = msg.text.trim().split(/\s+/, 2);
  const command = cmd.toLowerCase().replace(/@\w+$/, '');

  // A logbook question with "Log it" / "Cancel" (owner's chats only; nothing is logged yet).
  async function askToLog(id, chat, entry) {
    if (chat.role !== 'me') { await say(id, 'Only the owner\'s own chats can log. /sugar shows the glucose now.'); return { status: 200 }; }
    const q = describeLog(entry);
    if (q.error) { await say(id, q.error); return { status: 200 }; }
    let warning = '';
    if (entry.type === 'insulin' && doses?.ready) {
      try {
        const pid = await firstPerson(snapshot, doses);
        const recent = pid ? asMarkers(await doses.recent(pid)) : [];
        const w = pid && doubleDoseWarning(recent, pid, { t: Date.now() - (entry.back || 0), kind: entry.kind }, {}, Date.now());
        if (w) warning = `Careful: ${w}\n`;
      } catch { /* no warning rather than no question */ }
    }
    await say(id, `${warning}${q.text}`, { reply_markup: { inline_keyboard: [[{ text: 'Log it', callback_data: q.data }, { text: 'Cancel', callback_data: 'nolog' }]] } });
    return { status: 200 };
  }

  if (command === '/start') {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(arg || '')) {
      if (await store.chat(chatId)) return say(chatId, 'This chat is already linked to su94r. /sugar shows the glucose now, /stop unlinks.').then(() => ({ status: 200 }));
      return say(chatId, 'To get su94r alerts here, open a link made in su94r Mini (Health vault → Low alerts on Telegram), or on a phone su94r shared with you.').then(() => ({ status: 200 }));
    }
    const link = await store.takeLink(await sha256(arg));
    if (!link) return say(chatId, 'This link has expired or was already used. Make a new one in su94r Mini.').then(() => ({ status: 200 }));
    await store.linkChat({ chat_id: chatId, role: link.role, name: nameOf(msg.from) });
    await say(chatId, link.role === 'family'
      ? "Linked to su94r as family. You will be told here when a low is not handled. /sugar shows the glucose now, /stop unlinks."
      : "Linked to su94r. Low alerts come here with an \"I'm OK\" button, until you tap it or you are back up. /sugar shows the glucose now, /stop unlinks.");
    return { status: 200 };
  }

  const linked = await store.chat(chatId);
  if (!linked) return { status: 200 };                       // strangers get nothing
  if (command === '/stop') {
    await store.unlink(chatId);
    await say(chatId, 'Unlinked. No more su94r alerts here. A new link from su94r Mini links again.');
  } else if (command === '/sugar' || command === '/now') {
    let text;
    try { text = sugarText(await snapshot()); } catch { text = 'I could not reach LibreLinkUp just now.'; }
    await say(chatId, text);
  } else {
    const entry = parseLog(msg.text);
    if (entry) return askToLog(chatId, linked, entry);
    await say(chatId, linked.role === 'me'
      ? 'Log by writing, for example: 4 units rapid · 20 Lantus 30 min ago · 40 g. Or send a photo of your plate for a carb estimate. /sugar shows the glucose now, /stop unlinks this chat.'
      : '/sugar shows the glucose now. /stop unlinks this chat.');
  }
  return { status: 200 };
}

/** Whose doses: the first person followed (as Alexa does), else whoever has recent doses. */
async function firstPerson(snapshot, doses) {
  try { const p = (await snapshot()).people?.[0]; if (p?.pid) return p.pid; } catch { /* LibreLinkUp down */ }
  try { return (await doses.recent(null))[0]?.pid || null; } catch { return null; }
}

export async function telegramRoute(path, request, url, env, { store, json, keyOk, snapshot, night, api = tgApi, doses = null, meal = null, fetchImpl = (...a) => fetch(...a) }) {
  if (path !== 'tg' && !path.startsWith('tg/')) return null;
  if (!store.ready) return json({ error: 'not configured' }, 503);

  if (path === 'tg/webhook') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const r = await webhook(request, store, { api, snapshot, night, doses, meal, fetchImpl });
    return json({ ok: r.status === 200 }, r.status);
  }

  if (path === 'tg/proof') {
    // The proxy asks whether a meal-photo request really came from this server's bot.
    const bot = await store.bot();
    const given = request.headers.get('X-Su94r-Proof') || '';
    const ok = Boolean(bot?.webhook_secret) && /^[0-9a-f]{64}$/.test(given) && given === await mealProof(bot);
    return json({ ok }, ok ? 200 : 401);
  }

  if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const bot = await store.bot();

  if (path === 'tg/status') {
    const chats = bot ? await store.chats() : [];
    return json({
      configured: Boolean(bot?.token), bot: bot?.bot_username ? `@${bot.bot_username}` : null, enabled: Boolean(bot?.enabled),
      chats: chats.map((c) => ({ id: String(c.chat_id), name: c.name, role: c.role, linkedAt: c.linked_at })),
    });
  }

  if (path === 'tg/config') {
    const token = String(body.token || '').trim();
    if (!TOKEN_SHAPE.test(token)) return json({ error: 'bad-token', message: 'That does not look like a bot token from @BotFather (numbers, a colon, then letters).' }, 400);
    let me;
    try { me = await api(token, 'getMe'); } catch { return json({ error: 'bad-token', message: 'Telegram did not accept that token. Copy it again from @BotFather.' }, 400); }
    const secret = randomToken(24);
    const hook = `${String(env.SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1/su94r-cgm/tg/webhook`;
    try {
      await api(token, 'setWebhook', { url: hook, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      await api(token, 'setMyCommands', { commands: [{ command: 'sugar', description: 'The glucose now' }, { command: 'stop', description: 'Stop su94r alerts in this chat' }] }).catch(() => {});
    } catch (e) {
      return json({ error: 'webhook', message: `Telegram would not point the bot here (${e.message}).` }, 502);
    }
    await store.saveBot({ token, bot_username: me.username, bot_id: me.id, webhook_secret: secret, enabled: true });
    return json({ ok: true, bot: `@${me.username}` });
  }

  if (!bot?.token) return json({ error: 'no-bot', message: 'Set up the su94r bot first (paste its token from @BotFather).' }, 409);

  if (path === 'tg/link/new') {
    await store.sweepLinks().catch(() => {});
    const role = body.role === 'family' ? 'family' : 'me';
    const code = randomToken(16);
    await store.newLink(await sha256(code), role);
    return json({ url: `https://t.me/${bot.bot_username}?start=${code}`, role, expiresIn: LINK_TTL_MS / 1000 });
  }
  if (path === 'tg/chats/remove') {
    if (!body.chatId) return json({ error: 'chatId needed' }, 400);
    await store.unlink(String(body.chatId));
    await api(bot.token, 'sendMessage', { chat_id: String(body.chatId), text: 'This chat was unlinked from su94r in su94r Mini. No more alerts here.' }).catch(() => {});
    return json({ ok: true });
  }
  if (path === 'tg/enabled') {
    await store.setEnabled(Boolean(body.enabled));
    return json({ ok: true, enabled: Boolean(body.enabled) });
  }
  if (path === 'tg/document') {
    // The glucose report PDF from su94r Mini to the owner's chats.
    const name = String(body.name || 'su94r-report.pdf').replace(/[^\w.-]/g, '').slice(0, 80) || 'su94r-report.pdf';
    const data = String(body.data || '');
    if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 2_000_000) return json({ error: 'bad-file', message: 'That file could not be sent.' }, 400);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return json({ error: 'bad-file', message: 'Only PDF reports can be sent.' }, 400);
    const chats = await store.chats('me');
    if (!chats.length) return json({ error: 'no-chats', message: 'No Telegram chat is linked for you yet: Link my Telegram first.' }, 409);
    let n = 0;
    for (const c of chats) {
      const form = new FormData();
      form.append('chat_id', String(c.chat_id));
      if (body.caption) form.append('caption', String(body.caption).slice(0, 200));
      form.append('document', new Blob([bytes], { type: 'application/pdf' }), name);
      const res = await fetchImpl(`${TG}/bot${bot.token}/sendDocument`, { method: 'POST', body: form }).catch(() => null);
      if (res?.ok) n++;
    }
    return json({ ok: n > 0, sent: n }, n ? 200 : 502);
  }
  if (path === 'tg/test') {
    const chats = await store.chats('me');
    if (!chats.length) return json({ error: 'no-chats', message: 'No Telegram chat is linked for you yet: press Link my Telegram first.' }, 409);
    let n = 0;
    for (const c of chats) {
      try { await api(bot.token, 'sendMessage', { chat_id: c.chat_id, text: 'su94r test alert: Telegram alerts reach this chat. A real low comes with an "I\'m OK" button.' }); n++; } catch { /* next */ }
    }
    return json({ ok: n > 0, sent: n });
  }
  return json({ error: 'not found' }, 404);
}

/** A one-time link for a shared phone (share/extras), or null when no bot is set up. */
export async function telegramLinkFor(store, role) {
  if (!store.ready) return null;
  const bot = await store.bot().catch(() => null);
  if (!bot?.token || !bot.bot_username) return null;
  const code = randomToken(16);
  await store.newLink(await sha256(code), role === 'family' ? 'family' : 'me');
  return `https://t.me/${bot.bot_username}?start=${code}`;
}
