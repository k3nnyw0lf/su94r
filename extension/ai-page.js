import { watchContext } from './lifecycle.js';
import { withDefaults, displayUnits, mergeSeries } from './glucose.js';
import { loadReadings, wholeSeries } from './archive.js';
import { allPatients } from './store.js';
import { buildSummary, firstPrompt, chat, describeProvider, PROVIDERS } from './ai.js';

const $ = (id) => document.getElementById(id);
const local = chrome.storage.local;

let patients = [];
let pid = new URLSearchParams(location.search).get('p');
let history = [];   // messages sent to the AI (first one carries the summary)
let shown = [];     // what the page displays: { role, text, at }
let busy = false;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Small, safe Markdown subset: headings, bullets, bold, italics, paragraphs.
function renderMarkdown(text) {
  const out = [];
  let list = false;
  for (const raw of escapeHtml(text).split('\n')) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1<em>$2</em>');
    const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (bullet) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (head) out.push(`<h4>${head[1]}</h4>`);
    else if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

function draw() {
  const box = $('convo');
  box.replaceChildren(...shown.map((m) => {
    const div = document.createElement('div');
    div.className = `bubble ${m.role === 'user' ? 'me' : m.role === 'error' ? 'ai err' : 'ai'}`;
    if (m.role === 'assistant') {
      div.innerHTML = `<div class="meta">${escapeHtml(new Date(m.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</div>${renderMarkdown(m.text)}`;
    } else {
      div.textContent = m.text;
    }
    return div;
  }));
  if (busy) {
    const t = document.createElement('div');
    t.className = 'bubble ai thinking';
    t.textContent = 'Looking at your data…';
    box.append(t);
  }
  $('ask').hidden = !history.length;
  $('go').disabled = busy;
  // Switching person mid-answer would file one person's analysis under another.
  $('who').disabled = busy || patients.length < 2;
}

async function config() {
  const { ai } = await local.get('ai');
  return ai || {};
}

async function save(forPid = pid) {
  const { aiChats = {} } = await local.get('aiChats');
  aiChats[forPid] = { history, shown, at: Date.now() };
  await local.set({ aiChats });
}

async function load() {
  const { settings } = await local.get('settings');
  const s = withDefaults(settings);
  patients = await allPatients(s);
  if (!patients.some((p) => p.pid === pid)) pid = patients[0]?.pid || null;
  $('who').replaceChildren(...patients.map((p) => new Option(p.name || 'Unnamed', p.pid, false, p.pid === pid)));
  $('who').disabled = patients.length < 2;
  const cfg = await config();
  $('provider').textContent = describeProvider(cfg);
  const { aiChats = {} } = await local.get('aiChats');
  history = aiChats[pid]?.history || [];
  shown = aiChats[pid]?.shown || [];
  draw();
}

async function send(userText, isFirst) {
  const cfg = await config();
  if (!cfg.provider) {
    shown.push({ role: 'error', text: 'Connect an AI first: click "AI settings".' });
    draw();
    return;
  }
  if (PROVIDERS[cfg.provider].cloud && !cfg.consent?.[cfg.provider]) {
    shown.push({ role: 'error', text: `Allow sending your summary to ${PROVIDERS[cfg.provider].label} in AI settings first.` });
    draw();
    return;
  }
  const forPid = pid;
  busy = true;
  draw();
  try {
    let content = userText;
    if (isFirst) {
      const days = Number($('days').value);
      const person = patients.find((p) => p.pid === pid);
      const { settings, events = [] } = await local.get(['settings', 'events']);
      const units = displayUnits(withDefaults(settings), person);
      const from = Date.now() - days * 864e5;
      const saved = wholeSeries(await loadReadings(pid, from - 864e5));
      const recent = mergeSeries(person?.hist, person?.live);
      const cutoff = recent.length ? recent[0].t : Infinity;
      const points = [...saved.filter((p) => p.t < cutoff - 60e3), ...recent].sort((a, b) => a.t - b.t);
      if (!points.some((p) => p.t >= from)) throw new Error('No readings saved for that period yet.');
      const summary = buildSummary({ points, events: events.filter((e) => e.p === pid), person, units, days });
      content = firstPrompt(summary);
      history = [];
      shown = [{ role: 'user', text: `Analyze ${days} days for ${person?.name || 'this person'}.`, at: Date.now() }];
    } else {
      shown.push({ role: 'user', text: userText, at: Date.now() });
    }
    history.push({ role: 'user', content });
    const { text, assistant } = await chat(cfg, history);
    history.push(assistant);
    shown.push({ role: 'assistant', text, at: Date.now() });
    if (pid === forPid) await save(forPid);
  } catch (err) {
    if (history.length && history[history.length - 1].role === 'user') history.pop();
    shown.push({ role: 'error', text: err.message });
  } finally {
    busy = false;
    draw();
  }
}

$('go').addEventListener('click', () => send(null, true));
$('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q || busy) return;
  $('q').value = '';
  send(q, false);
});
$('clear').addEventListener('click', async () => {
  history = [];
  shown = [];
  await save();
  draw();
});
$('who').addEventListener('change', (e) => { pid = e.target.value; load(); });
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ai) config().then((c) => { $('provider').textContent = describeProvider(c); });
});

watchContext();
load();
