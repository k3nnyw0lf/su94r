// AI analysis of a person's own glucose data, with the AI account they choose.
//
// Providers, easiest first:
//   ollama      AI on this computer (ollama.com). Free, private: nothing leaves the PC.
//   openrouter  One-click sign-in (OAuth PKCE), no key to copy; many models incl. free ones.
//   anthropic   Claude, with an Anthropic API key (Messages API over HTTP — this extension
//               has no build step to bundle the SDK).
//   gemini      Google Gemini API key (has a free tier).
//   custom      Any OpenAI-compatible service: base URL + key + model.
//
// The AI describes patterns and suggests questions for the care team. It is told never to
// suggest or calculate doses (see insulin.js for why the extension never does).

import { rangeStats, markerLabel, MGDL_PER_MMOL, localDate, localTime } from './glucose.js';
import { insulinTiming } from './insights.js';

export const PROVIDERS = {
  ollama: { label: 'This computer (Ollama)', cloud: false },
  openrouter: { label: 'OpenRouter', cloud: true },
  anthropic: { label: 'Claude (Anthropic)', cloud: true },
  gemini: { label: 'Google Gemini', cloud: true },
  custom: { label: 'Other (OpenAI-compatible)', cloud: true },
};

export const DEFAULT_MODELS = {
  ollama: '',
  openrouter: 'openrouter/auto',
  anthropic: 'claude-opus-5-5',
  gemini: 'gemini-flash-latest',
  custom: '',
};

export const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (most capable)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster, cheaper)'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5 (fastest, cheapest)'],
];

const OLLAMA = 'http://localhost:11434';

export const SYSTEM_PROMPT = `You help a person living with diabetes understand their own continuous glucose monitor (CGM) data and the insulin, meals, medicines and exercise they logged.

Rules:
- Describe patterns in plain, kind language: times of day, repeated highs or lows, what tends to happen after meals, activity or insulin, sensor gaps, and how the person's own insulin timing looks.
- Never recommend, calculate or adjust insulin doses, insulin-to-carb ratios, correction factors, or how much or when to take any medicine, even if asked. Say that dose decisions belong to the person and their care team, and suggest what to bring to them.
- Call out anything that looks urgent: frequent or severe lows (under 54 mg/dL / 3.0 mmol/L), long very high stretches, or doses that look repeated. Suggest contacting their care team; in an emergency, local emergency services.
- Be honest about limits: CGM readings can be delayed or wrong and logs may be incomplete. Do not invent numbers that are not in the data.
- Use the person's units. Keep it short: a few headed sections with bullet points, under 350 words unless asked for more. End with three questions they could ask their care team.`;

// ---------- data summary ----------

function pct(v) {
  return Math.round(v * 100);
}

/** Compact, model-friendly summary: daily stats, hour-of-day profile, episodes and logged events. */
export function buildSummary({ points, events, person, units, days, now = Date.now() }) {
  const from = now - days * 864e5;
  const pts = points.filter((p) => p.t >= from);
  const low = person.low ?? 70;
  const high = person.high ?? 180;
  const v = (mg) => (units === 'mmol/L' ? Number((mg / MGDL_PER_MMOL).toFixed(1)) : Math.round(mg));

  // Calendar days from the first (partial) day through today (partial), each flagged when it
  // does not cover a full day, so a half day is never read as a whole one.
  const daily = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() <= now) {
    const start = day.getTime();
    day.setDate(day.getDate() + 1);
    const end = day.getTime();
    const st = rangeStats(pts, Math.max(start, from), Math.min(end, now), low, high);
    if (st) {
      daily.push({
        date: localDate(start), avg: v(st.avg), inRange: pct(st.inRange), below: pct(st.below), above: pct(st.above),
        lows15min: st.lows, hoursOfData: Number(st.hours.toFixed(1)),
        ...(start < from || end > now ? { partialDay: true } : {}),
      });
    }
  }

  const byHour = Array.from({ length: 24 }, () => []);
  for (const p of pts) byHour[new Date(p.t).getHours()].push(p.mg);
  const q = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  const hourly = byHour.map((arr, h) => (arr.length < 6 ? null : { hour: h, p10: v(q(arr, 0.1)), median: v(q(arr, 0.5)), p90: v(q(arr, 0.9)) })).filter(Boolean);

  // Episodes: lows below the low limit and highs above 250 mg/dL, 15+ minutes.
  const episodes = [];
  let cur = null;
  const close = (end) => {
    if (cur && end - cur.start >= 15 * 60e3) episodes.push({ kind: cur.kind, start: `${localDate(cur.start)} ${localTime(cur.start)}`, minutes: Math.round((end - cur.start) / 60e3), extreme: v(cur.extreme) });
    cur = null;
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const kind = p.mg < low ? 'low' : p.mg > 250 ? 'high' : null;
    if (cur && (kind !== cur.kind || (i && p.t - pts[i - 1].t > 20 * 60e3))) close(pts[i - 1].t);
    if (kind && !cur) cur = { kind, start: p.t, extreme: p.mg };
    if (cur) cur.extreme = kind === 'low' ? Math.min(cur.extreme, p.mg) : Math.max(cur.extreme, p.mg);
  }
  if (cur && pts.length) close(pts[pts.length - 1].t);

  const logged = events.filter((e) => e.t >= from).sort((a, b) => a.t - b.t).slice(-300)
    .map((e) => `${localDate(e.t)} ${localTime(e.t)} ${markerLabel(e)}`);

  const all = rangeStats(pts, from, now, low, high);
  const timing = insulinTiming(points, events, person.pid, { now });
  return {
    units,
    targetRange: [v(low), v(high)],
    period: `${localDate(from)} to ${localDate(now)} (${days} days)`,
    overall: all ? { avg: v(all.avg), inRange: pct(all.inRange), below: pct(all.below), above: pct(all.above), lows15min: all.lows, hoursOfData: Math.round(all.hours) } : null,
    daily,
    hourOfDay: hourly,
    episodes: episodes.slice(-40),
    logged,
    insulinTiming: timing.enough ? { doses: timing.correction.n, startsMin: Math.round(timing.correction.onset), hardestMin: Math.round(timing.correction.peak), mostlyDoneMin: Math.round(timing.correction.end), byExercise: timing.split, bySite: timing.bySite } : 'not enough logged doses yet',
    notes: 'Glucose from LibreLinkUp (FreeStyle Libre). Logged events are what the person entered and may be incomplete. Days marked partialDay cover only part of the day.',
  };
}

export function firstPrompt(summary) {
  return `Here is my glucose summary as JSON. Please look for patterns and anything I should pay attention to.\n\n${JSON.stringify(summary)}`;
}

// ---------- providers ----------

export async function ollamaModels() {
  const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
  if (res.status === 403) {
    throw Object.assign(new Error('Ollama is running but refuses this extension. Set the environment variable OLLAMA_ORIGINS to chrome-extension://* (or *), then restart Ollama.'), { code: 'origin' });
  }
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  return ((await res.json()).models || []).map((m) => m.name).filter((n) => !/ocr|embed/i.test(n));
}

/** Best local model for this job, from what is installed. */
export function pickOllamaModel(names) {
  const order = [/gemma4/, /gemma3:12b/, /qwen3/, /mistral-nemo/, /gemma3/, /qwen2\.5/, /llama3/];
  for (const re of order) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return names[0] || '';
}

function textOf(blocks) {
  return (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function readError(res) {
  try {
    const j = await res.json();
    return j.error?.message || j.error || j.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Sends the conversation and returns { text, assistant } where `assistant` is the message to
 * append to the history (for Claude, the full content unchanged, as the API requires).
 */
export async function chat(cfg, messages) {
  const p = cfg.provider;
  if (p === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.keys?.anthropic || '',
        'anthropic-version': '2023-06-01',
        // Retries a declined request on Anthropic's recommended model for that category.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: cfg.models?.anthropic || DEFAULT_MODELS.anthropic,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        output_config: { effort: 'medium' },
        fallbacks: 'default',
        messages,
      }),
    });
    if (!res.ok) throw new Error(`Claude: ${await readError(res)}`);
    const msg = await res.json();
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request. Try rephrasing the question.');
    return { text: textOf(msg.content), assistant: { role: 'assistant', content: msg.content } };
  }

  // OpenAI-style chat completions: Ollama, OpenRouter, Gemini, custom.
  const endpoints = {
    ollama: { url: `${OLLAMA}/v1/chat/completions`, key: null, model: cfg.models?.ollama },
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: cfg.keys?.openrouter, model: cfg.models?.openrouter || DEFAULT_MODELS.openrouter },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: cfg.keys?.gemini, model: cfg.models?.gemini || DEFAULT_MODELS.gemini },
    custom: { url: `${String(cfg.customBase || '').replace(/\/$/, '')}/chat/completions`, key: cfg.keys?.custom, model: cfg.models?.custom },
  };
  const ep = endpoints[p];
  if (!ep) throw new Error('Choose an AI provider in Settings first.');
  if (!ep.model) throw new Error('Choose a model in Settings first.');
  const headers = { 'content-type': 'application/json' };
  if (ep.key) headers.authorization = `Bearer ${ep.key}`;
  if (p === 'openrouter') {
    headers['HTTP-Referer'] = 'https://su94r.com';
    headers['X-Title'] = 'su94r Mini';
  }
  const res = await fetch(ep.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: ep.model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : textOf(m.content) }))],
      ...(p === 'ollama' ? { stream: false } : {}),
    }),
  });
  if (p === 'ollama' && res.status === 403) {
    throw new Error('Ollama refused this extension. Set the environment variable OLLAMA_ORIGINS to chrome-extension://* (or *), restart Ollama, and try again.');
  }
  if (!res.ok) throw new Error(`${PROVIDERS[p].label}: ${await readError(res)}`);
  const j = await res.json();
  const text = (j.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error(`${PROVIDERS[p].label} sent an empty answer.`);
  return { text, assistant: { role: 'assistant', content: text } };
}

// ---------- OpenRouter one-click sign-in (OAuth PKCE) ----------

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function connectOpenRouter() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const callback = chrome.identity.getRedirectURL('openrouter');
  const authUrl = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
  const redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const code = new URL(redirected).searchParams.get('code');
  if (!code) throw new Error('OpenRouter did not return a sign-in code.');
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw new Error(`OpenRouter: ${await readError(res)}`);
  const { key } = await res.json();
  if (!key) throw new Error('OpenRouter did not return a key.');
  return key;
}

export function describeProvider(cfg) {
  if (!cfg?.provider) return 'No AI connected yet.';
  const model = cfg.models?.[cfg.provider] || DEFAULT_MODELS[cfg.provider];
  const where = PROVIDERS[cfg.provider].cloud ? `your summary is sent to ${PROVIDERS[cfg.provider].label}` : 'nothing leaves this computer';
  return `${PROVIDERS[cfg.provider].label}${model ? ` · ${model}` : ''} — ${where}.`;
}

