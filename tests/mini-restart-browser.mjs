// Browser check that su94r Mini's windows survive a browser restart. Edge with a fresh profile
// loads a copy of the extension, turns on demo mode and opens a mini window and the board; the
// board is closed by hand, then the browser quits and starts again. The mini window must come back
// and the board must not; with the browser set to restore its last session, the mini window must
// not come back twice.
// A copy given with --load-extension is installed again at every start, so the browser fires
// onInstalled instead of onStartup (and a copy installed over DevTools is gone at the next start).
// The test copy therefore runs the startup reopen on install; its storage, and so what was
// remembered when the browser quit, carries over like an installed copy's.
//   node tests/mini-restart-browser.mjs [extension folder]  (needs Microsoft Edge)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ID = 'gcdoahfflgpabebcbhohaklfmpnnggpi';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = process.argv[2] || path.join(HERE, '../extension');
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'su94r-ext-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'su94r-prof-'));
fs.cpSync(SRC, EXT, { recursive: true, filter: (p) => !/[\\/](tools|node_modules)([\\/]|$)/.test(p) });
fs.appendFileSync(path.join(EXT, 'background.js'), '\n// Test copy: what onStartup does, at the install that stands in for it.\nchrome.runtime.onInstalled.addListener(() => reopenAtStartup());\n');
setTimeout(() => { console.log('FAIL run (timed out)'); process.exit(1); }, 240000).unref();

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await wait(300); } return v; };

// Edge over its DevTools pipe (fd 3 in, fd 4 out, messages end with \0). No sign-in, sync or
// background downloads: Edge otherwise signs a fresh profile in to the Windows account and
// installs that account's extensions into it.
function launch() {
  const proc = spawn(EDGE, ['--remote-debugging-pipe', `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, `--user-data-dir=${PROFILE}`,
    '--headless', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--no-service-autorun', '--enable-automation', '--password-store=basic',
    'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const pending = new Map();
  const dec = new StringDecoder('utf8');
  let buf = '', n = 0;
  proc.stdio[4].on('data', (d) => {
    buf += dec.write(d);
    for (let i; (i = buf.indexOf('\0')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      const p = pending.get(m.id);
      if (!p) continue;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`)); else p.res(m.result);
    }
  });
  const exited = new Promise((r) => proc.on('exit', r));
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++n;
    pending.set(id, { res, rej, method });
    proc.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  return { send, quit: async () => { await send('Browser.close').catch(() => {}); await exited; } };
}

const pages = async (b, file) => (await b.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page' && t.url.includes(`/${file}`));

// An options page to run extension code in (chrome.storage, chrome.runtime.sendMessage).
async function extPage(b) {
  const { targetId } = await b.send('Target.createTarget', { url: `chrome-extension://${ID}/options.html` });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const run = async (expression) => (await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  if (!(await until(() => run(`location.href.startsWith('chrome-extension:') && document.readyState === 'complete'`), 15000))) throw new Error('su94r Mini did not load');
  return { run, close: () => b.send('Target.closeTarget', { targetId }) };
}
const remembered = async (pg) => JSON.stringify(await pg.run(`chrome.storage.local.get('reopenAtStart').then((s) => s.reopenAtStart || [])`));

let b;
try {
  // First run: demo people, a mini window and the board, then the board is closed by hand.
  b = launch();
  let pg = await extPage(b);
  await pg.run(`chrome.storage.local.get('settings').then(({ settings = {} }) => chrome.storage.local.set({ settings: { ...settings, demo: true } }))`);
  const pid = await until(() => pg.run(`chrome.storage.local.get(null).then((all) => Object.values(all).find((v) => /^demo-/.test(v?.pid || ''))?.pid || null)`), 20000);
  check('demo people appear', Boolean(pid), pid);
  await pg.run(`chrome.runtime.sendMessage({ type: 'openMini', pid: ${JSON.stringify(pid)} })`);
  await pg.run(`chrome.runtime.sendMessage({ type: 'openBoard' })`);
  await until(async () => (await pages(b, 'mini.html')).length && (await pages(b, 'board.html')).length, 10000);
  check('mini window and board open', (await pages(b, 'mini.html')).length === 1 && (await pages(b, 'board.html')).length === 1);
  check('both are remembered', await remembered(pg) === JSON.stringify([pid, 'board']), await remembered(pg));
  await b.send('Target.closeTarget', { targetId: (await pages(b, 'board.html'))[0].targetId });
  await wait(3500);
  check('the board closed by hand is forgotten', await remembered(pg) === JSON.stringify([pid]), await remembered(pg));

  // Quit (the browser closes the mini window itself) and start again: it comes back, the board doesn't.
  await b.quit();
  b = launch();
  const back = await until(async () => (await pages(b, 'mini.html'))[0], 20000);
  check('mini window comes back after a restart', Boolean(back) && back.url.includes(`p=${encodeURIComponent(pid)}`), back?.url || 'none');
  await wait(2500);
  check('the board stays closed', (await pages(b, 'board.html')).length === 0);
  check('only one mini window', (await pages(b, 'mini.html')).length === 1);
  pg = await extPage(b);
  check('still remembered for the next start', await remembered(pg) === JSON.stringify([pid]), await remembered(pg));
  await pg.close();

  // Browser set to restore its last session: still one mini window, not two.
  await b.quit();
  const prefsFile = path.join(PROFILE, 'Default', 'Preferences');
  const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 1 };
  fs.writeFileSync(prefsFile, JSON.stringify(prefs));
  b = launch();
  await until(async () => (await pages(b, 'mini.html')).length, 20000);
  await wait(6000);
  const minis = (await pages(b, 'mini.html')).length;
  check('session restore does not double it', minis === 1, `${minis} mini windows`);
} catch (e) {
  check('run', false, e.message);
} finally {
  await b?.quit();
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
