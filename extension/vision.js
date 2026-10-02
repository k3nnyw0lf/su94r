// Photo estimates, with the AI you connected in Settings:
//   - a meal photo → an estimated carb range (published studies put photo AI and
//     dietitians alike at about ±15 g on average, so it is always shown as a range);
//   - a photo of an insulin pen's dose window → the number of units it shows.
// Either way the number only fills the field for you to check; nothing is saved until you
// press Add, and nothing here ever suggests how much insulin to take.

import { PROVIDERS, DEFAULT_MODELS } from './ai.js';

const OLLAMA = 'http://localhost:11434';

const PROMPTS = {
  meal: `Estimate the carbohydrates in this meal photo for a person with type 1 diabetes who will check your estimate.
Answer with JSON only, no other text:
{"items":[{"name":"...","grams":0,"carbs":0}],"carbsLow":0,"carbsHigh":0,"carbsBest":0,"confidence":"low|medium|high","note":"..."}
Give realistic portion weights. Make the range honest: wider when the portion or the food is uncertain. Do not mention insulin or doses.`,
  pen: `This is a photo of an insulin pen or syringe. Read the number of units shown in the dose window (or on the syringe scale).
Answer with JSON only, no other text: {"units":0,"confidence":"low|medium|high","note":"..."}
If you cannot read it clearly, use {"units":null,"confidence":"low","note":"why"}. Do not suggest any dose.`,
};

/** Shrinks a photo to at most `max` pixels on its longer side and returns { mime, base64, dataUrl }. */
export async function preparePhoto(file, max = 1024) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const base64 = btoa(bin);
  return { mime: 'image/jpeg', base64, dataUrl: `data:image/jpeg;base64,${base64}` };
}

/** The first JSON object in a model's answer. */
export function firstJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Sends one photo and a prompt to the connected AI; returns its text answer. */
async function askWithPhoto(cfg, photo, prompt) {
  const p = cfg.provider;
  if (!p) throw new Error('Connect an AI in Settings first (AI analysis).');
  if (PROVIDERS[p]?.cloud && !cfg.consent?.[p]) throw new Error(`Allow sending photos to ${PROVIDERS[p].label} in Settings (AI analysis) first.`);
  if (p === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.keys?.anthropic || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: cfg.models?.anthropic || DEFAULT_MODELS.anthropic,
        max_tokens: 1024,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: photo.mime, data: photo.base64 } },
          { type: 'text', text: prompt },
        ] }],
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude: ${j.error?.message || res.status}`);
    if (j.stop_reason === 'refusal') throw new Error('Claude declined this photo.');
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (p === 'ollama') {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.models?.ollama, stream: false, format: 'json', messages: [{ role: 'user', content: prompt, images: [photo.base64] }] }),
    });
    if (res.status === 403) throw new Error('Ollama refused this extension: set OLLAMA_ORIGINS to chrome-extension://* and restart Ollama.');
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Ollama: ${j.error || res.status}. The model must be able to read images (for example gemma3 or llama3.2-vision).`);
    return j.message?.content || '';
  }
  const ep = {
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: cfg.keys?.openrouter, model: cfg.models?.openrouter || DEFAULT_MODELS.openrouter },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: cfg.keys?.gemini, model: cfg.models?.gemini || DEFAULT_MODELS.gemini },
    custom: { url: `${String(cfg.customBase || '').replace(/\/$/, '')}/chat/completions`, key: cfg.keys?.custom, model: cfg.models?.custom },
  }[p];
  if (!ep) throw new Error('This AI cannot read photos.');
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ep.key ? { authorization: `Bearer ${ep.key}` } : {}) },
    body: JSON.stringify({ model: ep.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: photo.dataUrl } }] }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${PROVIDERS[p]?.label || p}: ${j.error?.message || res.status}`);
  return j.choices?.[0]?.message?.content || '';
}

/** Meal photo → { low, high, best, items, confidence, note }. */
export async function estimateCarbs(cfg, photo) {
  const j = firstJson(await askWithPhoto(cfg, photo, PROMPTS.meal));
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
  const best = num(j?.carbsBest);
  if (!j || best == null) throw new Error('The AI did not return a carb estimate. Try a clearer photo from above.');
  const low = Math.min(num(j.carbsLow) ?? best, best);
  const high = Math.max(num(j.carbsHigh) ?? best, best);
  return { low, high, best, items: Array.isArray(j.items) ? j.items.slice(0, 12) : [], confidence: String(j.confidence || 'low'), note: String(j.note || '').slice(0, 200) };
}

/** Pen photo → { units, confidence, note }; units is null when it could not be read. */
export async function readPen(cfg, photo) {
  const j = firstJson(await askWithPhoto(cfg, photo, PROMPTS.pen));
  const u = Number(j?.units);
  return {
    units: Number.isFinite(u) && u > 0 && u <= 100 ? Math.round(u * 2) / 2 : null,
    confidence: String(j?.confidence || 'low'),
    note: String(j?.note || '').slice(0, 200),
  };
}
