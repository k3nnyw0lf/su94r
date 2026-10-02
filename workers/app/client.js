// The su94r phone app (served by su94r-proxy as /app/app.js, after REPORT_SCRIPT from
// workers/doctor.js, which supplies esc() and reportHtml()). Server routes: workers/app.js.
//
// The phone's token is the one it got from a share code (su94r Mini → Share to another phone);
// it is kept in this browser's storage under the same name the /tv page uses, so a phone linked
// there already has the app. Nothing here dials out anywhere but this server.
(() => {
  'use strict';
  const K = { token: 'su94rScreenToken', role: 'su94rShared', ns: 'su94rNsToken', last: 'su94rAppLast', me: 'su94rAppMe', tab: 'su94rAppTab', pid: 'su94rAppPid', range: 'su94rAppRange', days: 'su94rAppDays' };
  const mem = {};
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return k in mem ? mem[k] : null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { delete mem[k]; } },
  };
  const readJson = (k) => { try { return JSON.parse(store.get(k) || 'null'); } catch (e) { return null; } };
  const $ = (id) => document.getElementById(id);
  const MIN = 60e3, HOUR = 3600e3, DAY = 864e5;
  const KIND = { rapid: 'rapid', short: 'regular', intermediate: 'NPH', basal: 'long-acting', mix: 'pre-mixed' };
  const SOURCE = { phone: 'phone', extension: 'su94r Mini', alexa: 'Alexa', telegram: 'Telegram' };
  const ARROW = ['', '↓', '↘', '→', '↗', '↑'];
  const ARROW_WORD = ['', 'falling fast', 'falling', 'steady', 'rising', 'rising fast'];

  const S = {
    me: null, live: null, liveAt: 0, online: true, recent: null,
    tab: store.get(K.tab) || 'now', pid: store.get(K.pid), range: Number(store.get(K.range)) || 6,
    days: Number(store.get(K.days)) || 14, hist: {}, report: {}, extras: null, dayView: null,
    log: { kind: 'rapid', amount: 0, ago: 0, meal: null }, installEvt: null, justLinked: false,
    pendingAck: null, treatGrams: null,
  };

  // ---------- helpers ----------
  const fmt = (mg, units) => (mg < 40 ? 'LO' : mg > 400 ? 'HI' : units === 'mmol/L' ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));
  const fmtDelta = (d, units) => (d == null ? '' : (d < 0 ? '−' : '+') + (units === 'mmol/L' ? Math.abs(d / 18.0182).toFixed(1) : Math.abs(Math.round(d))));
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dateKey = (t) => new Date(t).toDateString();
  function dayLabel(t) {
    const k = dateKey(t);
    if (k === dateKey(Date.now())) return 'Today';
    if (k === dateKey(Date.now() - DAY)) return 'Yesterday';
    return new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function ago(t) {
    const m = Math.round((Date.now() - t) / MIN);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }
  const what = (kind, amount) => (kind === 'carbs' ? amount + ' g of carbs' : amount + ' ' + (amount === 1 ? 'unit' : 'units') + ' of ' + KIND[kind] + ' insulin');
  const short = (e) => (e.type === 'meal' ? (e.amount ? e.amount + ' g carbs' : 'meal') : (e.amount ? e.amount + ' u ' : '') + (KIND[e.kind] || e.kind || 'insulin'));
  const card = (inner, cls) => '<section class="card' + (cls ? ' ' + cls : '') + '">' + inner + '</section>';
  const main = (html) => { $('main').innerHTML = html; };

  function fromB64u(s) {
    const str = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(str + '='.repeat((4 - (str.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function api(path, opts) {
    const o = opts || {};
    const res = await fetch('/' + path, {
      method: o.method || 'GET', cache: 'no-store',
      headers: Object.assign({ Authorization: 'Bearer ' + store.get(K.token) }, o.body ? { 'Content-Type': 'application/json' } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { unlinked(); throw new Error('This phone is no longer linked.'); }
    if (!res.ok) throw new Error(j.error || 'The server answered ' + res.status + '.');
    return j;
  }

  // ---------- people ----------
  function people() { return (S.me && S.me.people) || []; }
  function cur() {
    const list = people();
    let i = list.findIndex((p) => p.pid === S.pid);
    if (i < 0) i = 0;
    const live = S.live && S.live.people ? S.live.people[i] : null;
    const info = list[i] || (live ? { pid: '', name: live.name, units: live.units, low: live.low, high: live.high } : null);
    return { i, info, live, pid: info ? info.pid : '' };
  }
  function renderPeople() {
    const list = people();
    const el = $('people');
    el.hidden = list.length < 2;
    if (list.length < 2) return;
    const me = cur();
    el.innerHTML = list.map((p) => '<button class="chip" data-pid="' + esc(p.pid) + '" aria-pressed="' + (p.pid === me.pid) + '">' + esc(p.name || 'Person') + '</button>').join('');
  }

  // ---------- linking ----------
  async function join() {
    const m = /[#&]join=([0-9a-f]{64})/.exec(location.hash || '');
    if (!m) return;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* fine */ }
    main('<p class="muted">Linking this phone…</p>');
    const r = await fetch('/share/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: m[1] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      if (store.get(K.token)) return;     // linked before: just carry on
      throw new Error(j.error || 'That code did not work (' + r.status + ').');
    }
    store.set(K.token, j.token);
    store.set(K.role, j.role || 'me');
    if (j.nsToken) store.set(K.ns, j.nsToken);
    S.justLinked = true;
  }
  function welcome(problem) {
    $('tabs').hidden = true;
    $('people').hidden = true;
    $('st').textContent = '';
    main('<div class="welcome"><img src="/app/icon-192.png" alt=""><h2>su94r on this phone</h2>' +
      (problem ? '<div class="banner stale">' + esc(problem) + '</div>' : '') +
      '<p>Live glucose, history, logging and your 14-day report, with every computer off.</p>' +
      '<ol><li>On your computer open <b>su94r Mini → Health vault → Share to another phone</b>.</li>' +
      '<li>Press <b>My other phone</b> (or <b>A family member\'s phone</b>).</li>' +
      '<li>Scan the code with this phone\'s camera and open the link.</li></ol>' +
      '<p class="muted small">Linked before on this phone\'s /tv page? Open this app in that same browser.</p></div>');
  }
  function unlinked() {
    [K.token, K.role, K.ns, K.last, K.me].forEach((k) => store.del(k));
    welcome('This phone was removed in su94r Mini, so it no longer shows the glucose. Scan a new code to link it again.');
  }

  // ---------- data ----------
  async function refreshLive() {
    if (!store.get(K.token)) return;
    try {
      const j = await api('screen/data');
      S.live = j; S.liveAt = Date.now(); S.online = true;
      store.set(K.last, JSON.stringify(j));
    } catch (e) {
      if (!store.get(K.token)) return;
      S.online = false;
      if (!S.live) S.live = readJson(K.last);
    }
    status();
    if (S.tab === 'now') renderNow();
  }
  async function refreshRecent() {
    if (!store.get(K.token)) return;
    try { S.recent = await api('app/recent'); } catch (e) { /* keep the last */ }
    if (S.tab === 'now') renderNow();
  }
  function status() {
    const el = $('st');
    if (!S.live) { el.textContent = ''; return; }
    el.innerHTML = S.online
      ? '<span class="dot"></span>Updated ' + esc(ago(S.live.at || S.liveAt))
      : '<span class="dot off"></span>Offline · last ' + esc(clock(S.live.at || S.liveAt));
  }

  // ---------- the graph ----------
  function chart(o) {
    const w = 640, h = o.h || 280, pl = 44, pr = 10, pt = 14, pb = 32;
    const from = o.from, to = o.to, low = o.low || 70, high = o.high || 180, units = o.units;
    const pts = o.pts.filter((p) => p[0] >= from && p[0] <= to);
    const est = o.est;
    const vals = pts.map((p) => p[1]);
    if (est) [est.h30, est.h60].forEach((q) => { if (q) vals.push(q.hi); });
    const top = Math.min(400, Math.max(250, Math.ceil(Math.max(high + 20, ...vals) / 50) * 50));
    const bot = 40;
    const X = (t) => pl + ((t - from) / (to - from)) * (w - pl - pr);
    const Y = (v) => pt + (1 - (Math.min(top, Math.max(bot, v)) - bot) / (top - bot)) * (h - pt - pb);
    let s = '<svg class="g" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(o.label || 'Glucose graph') + '">';
    s += '<rect x="' + pl + '" y="' + Y(high) + '" width="' + (w - pl - pr) + '" height="' + (Y(low) - Y(high)) + '" style="fill:var(--band)"/>';
    [low, high].forEach((v) => {
      s += '<line x1="' + pl + '" x2="' + (w - pr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" style="stroke:var(--line)" stroke-dasharray="4 4"/>';
      s += '<text x="0" y="' + (Y(v) + 4) + '">' + fmt(v, units) + '</text>';
    });
    // Time ticks
    const span = to - from;
    const steps = [[3 * HOUR + 1, 30 * MIN], [6 * HOUR + 1, HOUR], [12 * HOUR + 1, 2 * HOUR], [DAY + 1, 3 * HOUR], [3 * DAY + 1, 12 * HOUR], [15 * DAY, DAY], [Infinity, 7 * DAY]];
    const step = steps.find((x) => span <= x[0])[1];
    const t0 = new Date(from); t0.setMinutes(0, 0, 0);
    if (step >= DAY) t0.setHours(0);
    for (let t = t0.getTime(); t <= to; t += step) {
      if (t < from) continue;
      const lab = step >= DAY ? new Date(t).toLocaleDateString([], step >= 7 * DAY ? { month: 'short', day: 'numeric' } : { weekday: 'short' })
        : step >= 12 * HOUR ? new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric' }) : new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: step < HOUR ? '2-digit' : undefined });
      s += '<line x1="' + X(t) + '" x2="' + X(t) + '" y1="' + pt + '" y2="' + (h - pb) + '" style="stroke:var(--soft)"/>';
      s += '<text x="' + X(t) + '" y="' + (h - 6) + '" text-anchor="middle">' + esc(lab) + '</text>';
    }
    // The readings: one line, broken where readings are missing.
    const gap = Math.max(25 * MIN, span / 60);
    let d = '';
    pts.forEach((p, k) => { d += (k === 0 || p[0] - pts[k - 1][0] > gap ? 'M' : 'L') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); });
    if (d) s += '<path d="' + d + '" fill="none" style="stroke:var(--line-c)" stroke-width="' + (pts.length > 400 ? 1.2 : 2.2) + '" stroke-linejoin="round"/>';
    if (pts.length <= 300) {
      pts.forEach((p) => {
        const c = p[1] < low ? 'var(--l)' : p[1] > high ? 'var(--h)' : 'var(--in)';
        s += '<circle cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="' + (pts.length > 120 ? 1.8 : 3) + '" style="fill:' + c + '"/>';
      });
    }
    // The learner's estimate: a fan from the latest reading.
    if (est && o.last) {
      const a = o.last, q30 = est.h30, q60 = est.h60;
      const P = [[a.t, a.mg, a.mg, a.mg]];
      if (q30) P.push([a.t + 30 * MIN, q30.mg, q30.lo, q30.hi]);
      if (q60) P.push([a.t + 60 * MIN, q60.mg, q60.lo, q60.hi]);
      const upper = P.map((q) => X(q[0]).toFixed(1) + ',' + Y(q[3]).toFixed(1)).join(' ');
      const lower = P.slice().reverse().map((q) => X(q[0]).toFixed(1) + ',' + Y(q[2]).toFixed(1)).join(' ');
      s += '<polygon points="' + upper + ' ' + lower + '" style="fill:var(--accent)" fill-opacity=".15"/>';
      s += '<polyline points="' + P.map((q) => X(q[0]).toFixed(1) + ',' + Y(q[1]).toFixed(1)).join(' ') + '" fill="none" style="stroke:var(--accent)" stroke-width="2" stroke-dasharray="5 4"/>';
    }
    if (to > Date.now() - MIN && from < Date.now()) s += '<line x1="' + X(Date.now()) + '" x2="' + X(Date.now()) + '" y1="' + pt + '" y2="' + (h - pb) + '" style="stroke:var(--muted)" stroke-dasharray="2 3"/>';
    // Logged insulin (bottom) and carbs (top)
    (o.events || []).filter((e) => e.t >= from && e.t <= to).forEach((e) => {
      const x = X(e.t).toFixed(1);
      if (e.type === 'meal') s += '<circle cx="' + x + '" cy="' + (pt + 9) + '" r="8" style="fill:var(--h)"/><text x="' + (Number(x) + 11) + '" y="' + (pt + 16) + '">' + (e.amount ? e.amount + 'g' : '') + '</text>';
      else s += '<path d="M' + x + ' ' + (h - pb - 18) + ' l8 14 h-16z" style="fill:var(--accent)"/><text x="' + (Number(x) + 10) + '" y="' + (h - pb - 5) + '">' + (e.amount ? e.amount + 'u' : '') + '</text>';
    });
    return s + '</svg>';
  }
  const legend = '<div class="legend"><span><i style="background:var(--in)"></i>in range</span><span><i style="background:var(--l)"></i>low</span><span><i style="background:var(--h)"></i>high</span><span><i style="background:var(--accent)"></i>insulin</span><span><i style="background:var(--h);border-radius:50%"></i>carbs</span></div>';

  // ---------- Now ----------
  function renderNow() {
    const c = cur();
    const L = c.live;
    if (!L) { main(card(S.online ? '<p class="muted">Waiting for the first reading…</p>' : '<p class="muted">Offline, and no reading saved on this phone yet.</p>')); return; }
    const l = L.latest, units = L.units, now = Date.now();
    const mins = l ? Math.round((now - l.t) / MIN) : null;
    const stale = !l || mins > 15;
    const state = stale ? 'stale' : l.mg < 55 ? 'urgent' : l.mg < L.low ? 'low' : l.mg > L.high ? 'high' : 'in';
    const hist = (L.history || []).slice();
    if (l && (!hist.length || hist[hist.length - 1][0] < l.t - MIN)) hist.push([l.t, l.mg]);
    let delta = null;
    if (l) { const ref = hist.filter((p) => Math.abs(p[0] - (l.t - 15 * MIN)) <= 8 * MIN).sort((a, b) => Math.abs(a[0] - (l.t - 15 * MIN)) - Math.abs(b[0] - (l.t - 15 * MIN)))[0]; if (ref) delta = l.mg - ref[1]; }
    const est = S.recent && S.recent.estimates ? S.recent.estimates[c.pid] : null;
    const events = S.recent ? S.recent.events.filter((e) => !c.pid || e.p === c.pid) : [];
    const from = now - S.range * HOUR;
    const to = est ? now + 65 * MIN : now + 5 * MIN;
    let html = '';
    if (!S.online) html += '<div class="banner off">Offline · showing the last reading this phone saw</div>';
    if (S.pendingAck) html += card('<h2>A low alert is waiting</h2><p>Tap once it is handled; the reminders stop.</p><button class="btn wide" id="ackBtn">I\'m OK</button>');
    const lowNow = l && !stale && l.mg < L.low;
    const ep = S.recent && S.recent.lows ? S.recent.lows[c.pid] : null;
    const tr = S.recent && S.recent.treating ? S.recent.treating[c.pid] : null;
    const plan = (S.recent && S.recent.plan) || { grams: 15, minutes: 15, text: '' };
    if (tr && !tr.done) {
      const left = Math.max(0, Math.round((tr.recheckAt - now) / MIN));
      html += card('<h2>Treating: ' + tr.grams + ' g at ' + esc(clock(tr.t)) + '</h2><p>' + (left ? 'Recheck at ' + esc(clock(tr.recheckAt)) + ', in ' + left + ' min.' : 'Time to recheck.') + (tr.by ? ' <span class="muted">Logged on ' + esc(tr.by) + '.</span>' : '') + '</p><p class="note">su94r tells you at the recheck where it went. Still low, the reminders start again.</p>');
    } else if ((lowNow || (ep && !ep.acked)) && S.me && S.me.canLog) {
      const g = S.treatGrams || plan.grams;
      html += card('<h2>Treat the low</h2>' + (plan.text ? '<p>Your plan: ' + esc(plan.text) + '</p>' : '') +
        '<div class="quick" style="justify-content:flex-start">' + [10, 15, 20, 30].concat([10, 15, 20, 30].indexOf(plan.grams) < 0 ? [plan.grams] : []).sort((a, b) => a - b).map((x) => '<button data-treat-g="' + x + '"' + (x === g ? ' style="background:var(--fg);color:var(--bg);border-color:var(--fg)"' : '') + '>' + x + ' g</button>').join('') + '</div>' +
        '<button class="btn wide" id="treatBtn" data-g="' + g + '">I treated it with ' + g + ' g</button><p class="note">Logs the carbs, stops the reminders, and rechecks in ' + plan.minutes + ' min.</p>');
    }
    let top = '<div class="big state-' + state + '"><span class="v">' + (l ? fmt(l.mg, units) : '—') + '</span>' +
      (l && !stale ? '<span class="a" aria-label="' + ARROW_WORD[l.trend] + '">' + (ARROW[l.trend] || '') + '</span>' : '') + '<span class="u">' + esc(units) + '</span></div>';
    top += '<div class="sub">' + (people().length > 1 || (c.info && c.info.name) ? esc(c.info ? c.info.name : '') + ' · ' : '') +
      (l ? (delta != null ? fmtDelta(delta, units) + ' in 15 min · ' : '') + esc(ago(l.t)) : 'no reading yet') + '</div>';
    if (l && !stale && l.mg < L.low) top += '<div class="banner low">' + (l.mg < 55 ? 'Urgent low' : 'Low') + ': below ' + fmt(L.low, units) + ' ' + esc(units) + '</div>';
    if (stale && l) top += '<div class="banner stale">No new reading for ' + esc(ago(l.t).replace(' ago', '')) + '. The sensor or the phone running LibreLink may be out of range.</div>';
    top += '<div class="segm" role="group" aria-label="Hours shown" style="margin-top:14px">' + [3, 6, 12].map((hh) => '<button data-range="' + hh + '" aria-pressed="' + (S.range === hh) + '">' + hh + ' h</button>').join('') + '</div>';
    top += chart({ pts: hist, from, to, low: L.low, high: L.high, units, events, est, last: l, label: 'Glucose for the last ' + S.range + ' hours' }) + legend;
    html += card(top);
    if (est && (est.h30 || est.h60)) {
      const part = (q, when) => (q ? '<b>' + when + '</b>: about ' + fmt(q.mg, units) + ' (' + fmt(q.lo, units) + '–' + fmt(q.hi, units) + ')' : '');
      html += card('<h2>Where it may head</h2><div class="est">' + [part(est.h30, 'In 30 min'), part(est.h60, 'In 1 hour')].filter(Boolean).join(' · ') + '</div>' +
        '<p class="note">An estimate from su94r Mini\'s learner, made ' + esc(ago(est.at)) + ' from your own past data. Not a reason to dose.</p>');
    }
    if (L.sensorStart) {
      const ends = L.sensorStart + ((S.recent && S.recent.sensorDays) || 14) * DAY;
      const left = ends - now;
      const when = left <= 0 ? 'Sensor has ended' : left < DAY ? 'Sensor ends ' + (dateKey(ends) === dateKey(now) ? 'today' : 'tomorrow') + ' at ' + clock(ends) : left < 2 * DAY ? 'Sensor ends tomorrow at ' + clock(ends) : 'Sensor ends in ' + Math.floor(left / DAY) + ' days (' + new Date(ends).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ')';
      html += '<p class="small" style="text-align:center;color:' + (left < DAY ? 'var(--h)' : 'var(--muted)') + '">' + esc(when) + '</p>';
    }
    main(html);
  }

  // ---------- History ----------
  function stats(pts, low, high) {
    const n = pts.length;
    if (!n) return null;
    let vl = 0, lo = 0, inr = 0, hi = 0, vh = 0, sum = 0, lows = 0, inLow = false, min = Infinity, max = -Infinity;
    pts.forEach((p) => {
      const v = p[1];
      sum += v; min = Math.min(min, v); max = Math.max(max, v);
      if (v < 54) vl++; else if (v < low) lo++; else if (v <= high) inr++; else if (v <= 250) hi++; else vh++;
      if (v < low && !inLow) { lows++; inLow = true; } else if (v >= low) inLow = false;
    });
    const slots = new Set(pts.map((p) => Math.floor(p[0] / (15 * MIN))));
    const mean = sum / n;
    return { n, vl: vl / n, lo: lo / n, inr: inr / n, hi: hi / n, vh: vh / n, mean, gmi: 3.31 + 0.02392 * mean, lows, min, max, slots: slots.size };
  }
  const pct = (x) => Math.round(x * 100) + '%';
  const rangeBar = (s) => '<div class="bar" aria-label="' + pct(s.inr) + ' in range">' + [['b-vl', s.vl], ['b-l', s.lo], ['b-in', s.inr], ['b-h', s.hi], ['b-vh', s.vh]].map((a) => '<span class="' + a[0] + '" style="width:' + (a[1] * 100).toFixed(1) + '%"></span>').join('') + '</div>';

  async function renderHistory() {
    const c = cur();
    const days = S.days;
    let html = '<div class="segm" role="group" aria-label="Days shown" style="margin-bottom:12px">' + [1, 7, 14, 30, 90].map((d) => '<button data-days="' + d + '" aria-pressed="' + (days === d) + '">' + (d === 1 ? '1 day' : d + ' d') + '</button>').join('') + '</div>';
    const cached = S.hist[days];
    if (!cached || Date.now() - cached.at > 5 * MIN) {
      main(html + card('<p class="muted">Loading ' + days + (days === 1 ? ' day' : ' days') + ' of readings…</p>'));
      try { S.hist[days] = { at: Date.now(), data: await api('app/history?days=' + days) }; } catch (e) { main(html + card('<p>' + esc(e.message) + '</p>')); return; }
      if (S.tab !== 'history' || S.days !== days) return;
    }
    const info = c.info || {};
    const low = info.low || 70, high = info.high || 180, units = info.units || 'mg/dL';
    const pts = (S.hist[days].data.points[c.pid] || []);
    const now = Date.now();
    if (!pts.length) { main(html + card('<p class="muted">The server has no readings for this period yet. It saves every reading from now on, and su94r Mini on your computer copies its own history once.</p>')); return; }
    const events = S.recent ? S.recent.events.filter((e) => !c.pid || e.p === c.pid) : [];
    if (S.dayView) {
      const start = new Date(S.dayView); start.setHours(0, 0, 0, 0);
      const end = Math.min(now, start.getTime() + DAY);
      const dp = pts.filter((p) => p[0] >= start.getTime() && p[0] < end);
      const s = stats(dp, low, high);
      html += card('<div class="row"><button class="btn ghost" data-back="1">‹ Back</button><h2 style="margin:0">' + esc(dayLabel(start.getTime())) + '</h2></div>' +
        (s ? '<div class="kv"><div><b>' + pct(s.inr) + '</b><span>in range</span></div><div><b>' + fmt(s.mean, units) + '</b><span>average</span></div><div><b>' + fmt(s.min, units) + '</b><span>lowest</span></div><div><b>' + fmt(s.max, units) + '</b><span>highest</span></div></div>' : '') +
        chart({ pts: dp, from: start.getTime(), to: start.getTime() + DAY, low, high, units, events, label: 'Glucose on ' + dayLabel(start.getTime()) }) + legend);
      main(html);
      return;
    }
    const from = now - days * DAY;
    const s = stats(pts, low, high);
    const coverage = Math.min(1, s.slots / (days * 96));
    html += card('<div class="kv"><div><b>' + pct(s.inr) + '</b><span>in range</span></div><div><b>' + fmt(s.mean, units) + '</b><span>average</span></div><div><b>' + s.gmi.toFixed(1) + '%</b><span>GMI</span></div><div><b>' + s.lows + '</b><span>lows</span></div></div>' +
      '<div style="margin-top:12px">' + rangeBar(s) + '</div>' +
      '<p class="muted small" style="margin:6px 0 0">' + pct(s.vl + s.lo) + ' below · ' + pct(s.hi + s.vh) + ' above · readings for ' + pct(coverage) + ' of the time</p>' +
      chart({ pts, from, to: now, low, high, units, events: days <= 2 ? events : [], label: 'Glucose for the last ' + days + ' days' }) +
      (coverage < 0.7 ? '<p class="note">The server has readings from ' + esc(dayLabel(pts[0][0])) + '. Each day fills in more; su94r Mini on your computer also copies the history it has kept.</p>' : ''));
    if (days > 1) {
      const byDay = new Map();
      pts.forEach((p) => { const k = dateKey(p[0]); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(p); });
      const rows = Array.from(byDay.entries()).reverse().map((kv) => {
        const ds = stats(kv[1], low, high);
        return '<li><button data-day="' + esc(kv[0]) + '">' + esc(dayLabel(kv[1][0][0])) + '</button>' + rangeBar(ds) + '<span class="muted">' + pct(ds.inr) + ' · ' + fmt(ds.mean, units) + '</span></li>';
      }).join('');
      html += card('<h2>Day by day</h2><ul class="days">' + rows + '</ul><p class="note">Tap a day to see it.</p>');
    }
    main(html);
  }

  // ---------- Log ----------
  function recentList(editable) {
    const c = cur();
    const ev = S.recent ? S.recent.events.filter((e) => !c.pid || e.p === c.pid).sort((a, b) => b.t - a.t) : [];
    if (!ev.length) return '<p class="muted">Nothing logged in the last 48 hours.</p>';
    return '<ul class="list">' + ev.slice(0, 30).map((e) => '<li><span class="t">' + esc(dayLabel(e.t) === 'Today' ? clock(e.t) : dayLabel(e.t) + ' ' + clock(e.t)) + '</span><span>' + esc(short(e)) + '</span>' +
      '<span class="src">' + esc((SOURCE[e.source] || e.source || '') + (e.by ? ' · ' + e.by : '')) + '</span>' + (editable && e.mine ? '<button data-undo="' + esc(e.id) + '">Undo</button>' : '') + '</li>').join('') + '</ul>';
  }
  function renderLog() {
    const canLog = S.me && S.me.canLog;
    if (!canLog) {
      main(card('<h2>Logging</h2><p>This phone shows the glucose and the history. It can\'t log yet: the owner can allow it in su94r Mini (Share to another phone) or in their own su94r app (More).</p>') +
        card('<h2>Last 48 hours</h2>' + recentList(false)));
      return;
    }
    const L = S.log, carbs = L.kind === 'carbs';
    const kindBtn = (k, label) => '<button data-kind="' + k + '" aria-pressed="' + (L.kind === k) + '">' + label + '</button>';
    const quick = carbs ? [10, 15, 20, 30, 45, 60, 75, 90] : [1, 2, 3, 4, 5, 6, 8, 10];
    const whens = [[0, 'Now'], [15, '15 min ago'], [30, '30 min ago'], [60, '1 h ago'], [120, '2 h ago']];
    let m = '';
    if (carbs) {
      m = '<div class="photo"><label class="btn ghost" style="display:block">📷 Estimate from a photo<input type="file" accept="image/*" capture="environment" id="photo"></label></div>';
      if (L.meal && L.meal.busy) m += '<div class="meal">Looking at the photo…</div>';
      else if (L.meal && L.meal.error) m += '<div class="meal">' + esc(L.meal.error) + '</div>';
      else if (L.meal && L.meal.food) m += '<div class="meal">About <b>' + L.meal.total + ' g</b> of carbs (likely ' + L.meal.low + '–' + L.meal.high + ' g, ' + esc(L.meal.confidence) + ' confidence)' +
        (L.meal.items.length ? ': ' + L.meal.items.map((x) => esc(x.name) + (x.carbs != null ? ' about ' + x.carbs + ' g' : '')).join(', ') : '') + '.<br><span class="muted small">Photo estimates are rough: check the number before logging.</span></div>';
    }
    const mic = (window.SpeechRecognition || window.webkitSpeechRecognition) ? '<button class="btn ghost" id="micBtn" style="display:block;width:100%;margin-bottom:12px">🎤 Say it: "4 units rapid" or "40 grams"</button>' + (S.heard ? '<p class="note" style="margin-top:-6px">' + esc(S.heard) + '</p>' : '') : '';
    const html = card('<h2>Log</h2>' + mic + '<div class="kinds">' + kindBtn('rapid', 'Rapid insulin') + kindBtn('basal', 'Long-acting') + kindBtn('carbs', 'Carbs') + '</div>' + m +
      '<div class="row" style="margin-top:10px"><label class="muted small" for="otherKind">Other insulin</label><select id="otherKind"><option value="">—</option>' +
      [['short', 'Regular'], ['intermediate', 'NPH'], ['mix', 'Pre-mixed']].map((o) => '<option value="' + o[0] + '"' + (L.kind === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<div class="amount"><button data-step="-1" aria-label="Less">−</button><output id="amt" aria-live="polite">' + (L.amount || 0) + '<small>' + (carbs ? 'grams' : 'units') + '</small></output><button data-step="1" aria-label="More">+</button></div>' +
      '<div class="quick">' + quick.map((q) => '<button data-amount="' + q + '">' + q + (carbs ? ' g' : ' u') + '</button>').join('') + '</div>' +
      '<div class="muted small">When</div><div class="when">' + whens.map((w) => '<button data-ago="' + w[0] + '" aria-pressed="' + (L.ago === w[0]) + '">' + w[1] + '</button>').join('') + '</div>' +
      '<button class="btn wide" id="logBtn"' + (L.amount > 0 ? '' : ' disabled') + '>' + (L.amount > 0 ? 'Log ' + esc(what(L.kind, L.amount)) : 'Choose an amount') + '</button>' +
      '<p class="note">Logged doses reach su94r Mini, Alexa and the double-dose check. su94r never suggests a dose.</p>');
    main(html + card('<h2>Last 48 hours</h2>' + recentList(true)));
  }
  function setAmount(v) {
    const carbs = S.log.kind === 'carbs';
    const max = carbs ? 300 : 100;
    S.log.amount = Math.max(0, Math.min(max, carbs ? Math.round(v) : Math.round(v * 2) / 2));
    renderLog();
  }

  // A sheet that asks before anything is saved.
  function sheet(inner, buttons) {
    closeSheet();
    const old = $('toast'); if (old) old.remove();
    const bg = document.createElement('div');
    bg.className = 'sheet-bg'; bg.id = 'sheet';
    bg.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + inner + '<div class="row">' + buttons.map((b, k) => '<button class="' + b[1] + '" data-b="' + k + '">' + esc(b[0]) + '</button>').join('') + '</div></div>';
    bg.addEventListener('click', (e) => {
      if (e.target === bg) return closeSheet();
      const k = e.target.getAttribute && e.target.getAttribute('data-b');
      if (k != null) buttons[Number(k)][2](e.target);
    });
    document.body.appendChild(bg);
    const first = bg.querySelector('button'); if (first) first.focus();
  }
  function closeSheet() { const s = $('sheet'); if (s) s.remove(); }
  let toastTimer = null;
  function toast(text, action, fn) {
    const old = $('toast'); if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'toast'; t.id = 'toast'; t.setAttribute('role', 'status');
    t.innerHTML = '<span>' + esc(text) + '</span>' + (action ? '<button>' + esc(action) + '</button>' : '');
    if (action) t.querySelector('button').onclick = () => { t.remove(); fn(); };
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), action ? 10000 : 4000);
  }
  // Log by voice: the phone's own speech recognition turns it into text; the server reads the
  // text the same way as a Telegram message (tglog.js); nothing is saved before "Log it".
  function listen(btn) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = navigator.language && /^es/i.test(navigator.language) ? 'es-US' : 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    btn.disabled = true; btn.textContent = '🎤 Listening…';
    rec.onerror = (e) => { S.heard = e.error === 'not-allowed' ? 'The microphone is blocked for su94r. Allow it in the browser settings.' : 'Did not catch that. Try again.'; renderLog(); };
    rec.onend = () => { if (btn.isConnected) { btn.disabled = false; btn.textContent = '🎤 Say it: "4 units rapid" or "40 grams"'; } };
    rec.onresult = async (e) => {
      const alts = Array.from(e.results[0] || []).map((a) => a.transcript);
      let r = null;
      for (const text of alts) {
        try { r = await api('app/parse', { method: 'POST', body: { text } }); } catch (x) { r = { ok: false, error: x.message }; }
        if (r.ok) break;
      }
      if (!r || !r.ok) { S.heard = 'Heard "' + (alts[0] || '') + '". ' + ((r && r.error) || ''); renderLog(); return; }
      S.heard = 'Heard "' + r.heard + '".';
      S.log.kind = r.kind; S.log.amount = r.amount; S.log.ago = r.minutesAgo || 0; S.log.meal = null;
      renderLog();
      askToLog();
    };
    try { rec.start(); } catch (x) { btn.disabled = false; }
  }

  function askToLog() {
    const L = S.log, c = cur();
    const when = L.ago ? L.ago + ' min ago' : 'now';
    sheet('<h3>Log ' + esc(what(L.kind, L.amount)) + ', ' + esc(when) + '?</h3>' + (c.info && c.info.name ? '<p class="muted">For ' + esc(c.info.name) + '.</p>' : ''),
      [['Log it', 'btn', () => send(false)], ['Cancel', 'btn ghost', closeSheet]]);
  }
  async function send(confirm) {
    const L = S.log, c = cur();
    document.querySelectorAll('#sheet button').forEach((b) => { b.disabled = true; });
    let r;
    try { r = await api('app/log', { method: 'POST', body: { kind: L.kind, amount: L.amount, minutesAgo: L.ago, pid: c.pid, confirm } }); }
    catch (e) { sheet('<h3>Not logged</h3><p>' + esc(e.message) + '</p>', [['Close', 'btn ghost', closeSheet]]); return; }
    if (r.confirm) {
      sheet('<h3>Log ' + esc(what(L.kind, L.amount)) + ' anyway?</h3><div class="warnbox">' + esc(r.warning) + '</div><p class="muted small">Check before logging a second dose.</p>',
        [['Log anyway', 'btn warn', () => send(true)], ['Cancel', 'btn ghost', closeSheet]]);
      return;
    }
    closeSheet();
    S.log.amount = 0; S.log.meal = null;
    toast(r.text, 'Undo', () => undo(r.id));
    await refreshRecent();
    if (S.tab === 'log') renderLog();
  }
  async function undo(id) {
    try { await api('app/undo', { method: 'POST', body: { id } }); toast('Removed.'); }
    catch (e) { toast(e.message); }
    await refreshRecent();
    if (S.tab === 'log') renderLog();
  }
  function shrink(file, max) {
    return new Promise((ok, no) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        ok(cv.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); no(new Error('This phone could not open that photo.')); };
      img.src = url;
    });
  }
  async function photo(file) {
    S.log.meal = { busy: true }; renderLog();
    try {
      const image = await shrink(file, 1024);
      const res = await fetch('/app/meal', { method: 'POST', cache: 'no-store', headers: { Authorization: 'Bearer ' + store.get(K.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'The photo check answered ' + res.status + '.');
      const m = j.meal;
      if (!m) throw new Error('Could not read that photo. Type the grams instead.');
      if (!m.food) throw new Error('No food seen in that photo. Type the grams instead.');
      S.log.meal = m; S.log.amount = m.total;
    } catch (e) { S.log.meal = { error: e.message }; }
    if (S.tab === 'log') renderLog();
  }

  // ---------- low alerts in this app (web push) ----------
  async function swReady() {
    return Promise.race([navigator.serviceWorker.ready, new Promise((ok, no) => setTimeout(() => no(new Error('The app is still installing its helper. Try again in a moment.')), 8000))]);
  }
  async function pushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try { const reg = await swReady(); return (await reg.pushManager.getSubscription()) && Notification.permission === 'granted' ? 'on' : 'off'; } catch (e) { return 'off'; }
  }
  async function pushOn() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed. Allow them for su94r in the phone\'s settings, then try again.');
    const { key } = await api('app/push/key');
    const reg = await swReady();
    let sub = await reg.pushManager.getSubscription();
    const opts = { userVisibleOnly: true, applicationServerKey: fromB64u(key) };
    try { if (!sub) sub = await reg.pushManager.subscribe(opts); }
    catch (e) { if (sub) await sub.unsubscribe(); sub = await reg.pushManager.subscribe(opts); }
    const j = sub.toJSON();
    await api('app/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
  }
  async function pushOff() {
    const reg = await swReady();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api('app/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }

  // ---------- supplies ----------
  const SUPPLY = [['rapid', 'Rapid insulin'], ['basal', 'Long-acting insulin'], ['short', 'Regular insulin'], ['intermediate', 'NPH insulin'], ['mix', 'Pre-mixed insulin'], ['sensors', 'Sensors']];
  function editSupply(item) {
    const s = (S.supplies || []).find((x) => x.item === item) || null;
    const free = SUPPLY.filter((o) => !(S.supplies || []).some((x) => x.item === o[0]));
    sheet('<h3>' + (s ? esc(s.label) : 'Add supplies') + '</h3>' +
      (s ? '' : '<label for="supItem">What</label><select id="supItem">' + free.map((o) => '<option value="' + o[0] + '">' + o[1] + '</option>').join('') + '</select>') +
      '<label for="supHave">On hand now (units of insulin, or sensors)</label><input id="supHave" type="number" inputmode="decimal" min="0" value="' + (s ? s.left : '') + '">' +
      '<p class="note" style="margin-top:-4px">A U-100 pen holds 300 units; a 10 mL vial 1000.</p>' +
      '<label for="supWarn">Remind me when it is down to</label><input id="supWarn" type="number" inputmode="decimal" min="0" placeholder="for example 300 units, or 1 sensor" value="' + (s && s.warnAt ? s.warnAt : '') + '">' +
      '<label for="supRefill">Refill date (optional)</label><input id="supRefill" type="date" value="' + (s && s.refillOn ? esc(s.refillOn) : '') + '">',
      [['Save', 'btn', () => saveSupply(s ? s.item : null)]].concat(s ? [['Remove', 'btn ghost', () => removeSupply(s.item)]] : []).concat([['Cancel', 'btn ghost', closeSheet]]));
  }
  async function saveSupply(item) {
    const body = { pid: cur().pid, item: item || $('supItem').value, onHand: $('supHave').value, warnAt: $('supWarn').value, refillOn: $('supRefill').value || null };
    try { await api('app/supplies/save', { method: 'POST', body }); closeSheet(); toast('Saved.'); }
    catch (e) { toast(e.message); return; }
    if (S.tab === 'more') renderMore();
  }
  async function removeSupply(item) {
    try { await api('app/supplies/remove', { method: 'POST', body: { pid: cur().pid, item } }); closeSheet(); toast('Removed.'); }
    catch (e) { toast(e.message); return; }
    if (S.tab === 'more') renderMore();
  }

  // ---------- treating a low ----------
  function askToTreat(grams) {
    const plan = (S.recent && S.recent.plan) || { minutes: 15 };
    sheet('<h3>Log ' + grams + ' g to treat the low?</h3><p class="muted">The reminders stop, and su94r rechecks in ' + plan.minutes + ' minutes.</p>',
      [['Log it', 'btn', async () => {
        document.querySelectorAll('#sheet button').forEach((b) => { b.disabled = true; });
        try {
          const r = await api('app/treat', { method: 'POST', body: { grams, pid: cur().pid } });
          closeSheet(); S.treatGrams = null; S.pendingAck = null;
          toast(r.text, 'Undo', () => undo(r.id));
        } catch (e) { sheet('<h3>Not logged</h3><p>' + esc(e.message) + '</p>', [['Close', 'btn ghost', closeSheet]]); return; }
        await refreshRecent();
      }], ['Cancel', 'btn ghost', closeSheet]]);
  }
  async function sendAck() {
    const a = S.pendingAck; if (!a) return;
    try {
      const r = await fetch(a, { method: 'POST', cache: 'no-store' });
      toast(r.ok ? 'Got it. Reminders for this low stop.' : 'That alert was already answered.');
    } catch (e) { toast('Could not reach the server. Try again.'); return; }
    S.pendingAck = null;
    renderNow();
  }

  // ---------- Report ----------
  async function renderReport() {
    const c = cur();
    const r = S.report[c.pid];
    if (!r || Date.now() - r.at > 10 * MIN) {
      main(card('<p class="muted">Making the 14-day report…</p>'));
      try { S.report[c.pid] = { at: Date.now(), data: await api('app/report?pid=' + encodeURIComponent(c.pid)) }; } catch (e) { main(card('<p>' + esc(e.message) + '</p>')); return; }
      if (S.tab !== 'report') return;
    }
    main('<div class="row noprint" style="margin-bottom:12px"><button class="btn ghost" id="print">Print or save as PDF</button></div>' +
      card(reportHtml(S.report[c.pid].data), 'report') +
      '<p class="note noprint">For your doctor: su94r Mini → Health vault → <b>Live link for my doctor</b> makes a private link that always shows this report.</p>');
    let labs = null;
    try { labs = await api('app/labs?pid=' + encodeURIComponent(c.pid)); } catch (e) { labs = null; }
    if (S.tab !== 'report' || !labs) return;
    $('main').insertAdjacentHTML('beforeend', card('<h2>Lab results</h2>' + (labs.labs.length ? '<ul class="list">' + labs.labs.map((l) => '<li><span class="t">' + esc(l.takenOn) + '</span><span>' + esc(l.name) + ' <b>' + esc(String(l.value)) + (l.unit ? ' ' + esc(l.unit) : '') + '</b></span>' + (labs.canEdit ? '<button data-lab-del="' + esc(l.id) + '" style="margin-left:auto">Remove</button>' : '') + '</li>').join('') + '</ul>' : '<p class="muted">None yet. An A1c typed in here shows in the report and the doctor\'s link next to the GMI.</p>') +
      (labs.canEdit ? '<button class="btn ghost" id="labAdd">Add a lab result</button>' : ''), 'noprint'));
  }

  function editLab() {
    const today = new Date(); const iso = new Date(today.getTime() - today.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
    sheet('<h3>Add a lab result</h3><label for="labKind">Test</label><select id="labKind"><option value="a1c">A1c (%)</option><option value="other">Another test</option></select>' +
      '<div id="labOther" hidden><label for="labName">Name</label><input id="labName" maxlength="40" placeholder="for example LDL cholesterol"><label for="labUnit">Unit</label><input id="labUnit" maxlength="16" placeholder="for example mg/dL"></div>' +
      '<label for="labValue">Result</label><input id="labValue" type="number" inputmode="decimal" step="any"><label for="labDate">Date of the test</label><input id="labDate" type="date" value="' + iso + '">',
      [['Save', 'btn', saveLab], ['Cancel', 'btn ghost', closeSheet]]);
    $('labKind').onchange = () => { $('labOther').hidden = $('labKind').value !== 'other'; };
  }
  async function saveLab() {
    const body = { pid: cur().pid, kind: $('labKind').value, name: $('labName').value, unit: $('labUnit').value, value: $('labValue').value, takenOn: $('labDate').value };
    try { await api('app/labs/save', { method: 'POST', body }); closeSheet(); toast('Saved. It shows in the report.'); }
    catch (e) { toast(e.message); return; }
    S.report = {};
    if (S.tab === 'report') renderReport();
  }
  async function removeLab(id) {
    try { await api('app/labs/remove', { method: 'POST', body: { pid: cur().pid, id } }); toast('Removed.'); }
    catch (e) { toast(e.message); return; }
    S.report = {};
    if (S.tab === 'report') renderReport();
  }

  // ---------- More ----------
  async function renderMore() {
    const role = (S.me && S.me.role) || store.get(K.role) || 'me';
    const ns = store.get(K.ns), base = location.origin;
    const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const copy = (v) => ' <button class="btn ghost" style="padding:4px 10px" data-copy="' + esc(v) + '">Copy</button>';
    const install = standalone ? '<p>Installed. Open su94r from the home screen.</p>'
      : S.installEvt ? '<p>Put su94r on the home screen like any app.</p><button class="btn" id="install">Install su94r</button>'
        : ios ? '<p>In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>' : '<p>In Chrome tap <b>⋮</b>, then <b>Install app</b> or <b>Add to Home screen</b>.</p>';
    let html = '';
    if (S.justLinked) html += '<div class="banner stale" style="margin:0 0 12px">This phone is linked. Turn on its low alerts below, and install the app.</div>';
    const ps = await pushState();
    if (S.tab !== 'more') return;
    let pc = '<h2>Low alerts in this app</h2>';
    if (ps === 'unsupported') pc += ios && !standalone ? '<p>On iPhone, install the app first (Safari: Share → <b>Add to Home Screen</b>), open it from the home screen, then turn alerts on here.</p>' : '<p>This browser cannot show alerts from the app. Use ntfy or Telegram below.</p>';
    else if (ps === 'denied') pc += '<p>Notifications are blocked for su94r on this phone. Allow them in the phone\'s settings, then come back here.</p>';
    else if (ps === 'on') pc += '<p>On. ' + (role === 'family' ? 'This phone rings when a low is not handled (once the owner switches on “Tell caregivers too”).' : 'This phone rings for every low until “I\'m OK”, for Low soon and for sensor warnings.') + '</p><div class="row"><button class="btn ghost" id="pushTest">Send a test</button><button class="btn ghost" id="pushOff">Turn off</button></div>';
    else pc += '<p>' + (role === 'family' ? 'Ring this phone when a low is not handled.' : 'Ring this phone for lows, with an “I\'m OK” button. No other app needed.') + '</p><button class="btn" id="pushOn">Ring for lows on this phone</button>';
    pc += '<p class="note">Your phone\'s silent and Do Not Disturb settings still apply; for nights, let su94r (or Chrome) through.</p>';
    html += card(pc);
    html += card('<h2>Install</h2>' + install);
    if (!S.extras) { try { S.extras = await api('share/extras'); } catch (e) { S.extras = {}; } }
    const x = S.extras || {}, a = x.alerts;
    let alerts = '<h2>Also on ntfy or Telegram</h2>';
    if (a) {
      alerts += '<p>' + (a.role === 'family' ? 'You are told when a low is not handled.' + (a.on ? '' : ' The owner has not switched family alerts on yet.') : 'The same alerts as the owner: every low, repeated until “I\'m OK”.') + ' The same alerts can also come through <b>ntfy</b> (free) or Telegram.</p>' +
        '<p><a class="btn" href="ntfy://' + esc(a.url.replace(/^https?:\/\//, '')) + '">Subscribe in ntfy</a> <a class="btn ghost" href="' + esc(a.url) + '">Open in the browser</a></p>' +
        '<p class="muted small">Get ntfy: <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy">Play Store</a> · <a href="https://apps.apple.com/app/ntfy/id1625396347">App Store</a>. Or in ntfy tap + and paste <code>' + esc(a.topic) + '</code>' + copy(a.topic) + '</p>';
    } else alerts += '<p class="muted">Low alerts are not set up on the server yet: su94r Mini → Health vault → Low alerts.</p>';
    if (x.telegram) alerts += '<p>Prefer Telegram? <a class="btn ghost" href="' + esc(x.telegram) + '">Open in Telegram</a> then press <b>Start</b>. The link works once, for 15 minutes.</p>';
    html += card(alerts);
    if (ns) html += card('<h2>Watch and widgets</h2><p>In <b>GlucoDataHandler</b> (free, also on the Pixel Watch): Sources → Nightscout, with this address and token.</p><p class="small"><code>' + esc(base) + '/ns</code>' + copy(base + '/ns') + '</p><p class="small"><code>' + esc(ns) + '</code>' + copy(ns) + '</p>');
    if (role === 'me') {
      let phones = null;
      try { phones = (await api('app/phones')).phones; } catch (e) { /* shown below */ }
      if (S.tab !== 'more') return;
      html += card('<h2>Family phones</h2>' + (phones == null ? '<p class="muted">Could not load the family phones.</p>'
        : !phones.length ? '<p class="muted">No family phones linked yet. Make a family code in su94r Mini → Share to another phone.</p>'
          : '<p class="muted small">A family member who lives with you can log doses and meals too. Their doses get the same double-dose check.</p><ul class="list">' +
            phones.map((p) => '<li><span>' + esc(p.name) + '</span><span class="src">' + (p.canLog ? 'can log' : 'reads only') + '</span><button data-allow="' + esc(p.id) + '" data-on="' + (p.canLog ? '0' : '1') + '">' + (p.canLog ? 'Stop logging' : 'Allow logging') + '</button></li>').join('') + '</ul>'));
    }
    let sup = null;
    try { sup = await api('app/supplies?pid=' + encodeURIComponent(cur().pid)); } catch (e) { sup = null; }
    if (S.tab !== 'more') return;
    if (sup) {
      const items = sup.items || [];
      S.supplies = items;
      html += card('<h2>Supplies</h2>' + (items.length ? '<ul class="list">' + items.map((s) => '<li><span>' + esc(s.label) + '</span><span class="src" style="' + (s.low || s.refillDue ? 'color:var(--h);font-weight:600' : '') + '">' + s.left + ' ' + esc(s.unit) + ' left' + (s.daysLeft != null ? ' · ~' + s.daysLeft + ' d' : '') + (s.refillOn ? ' · refill ' + esc(s.refillOn) : '') + '</span>' + (sup.canEdit ? '<button data-supply="' + esc(s.item) + '">Edit</button>' : '') + '</li>').join('') + '</ul>' : '<p class="muted">Nothing tracked yet.</p>') +
        (sup.canEdit && items.length < 6 ? '<button class="btn ghost" data-supply="">Add insulin or sensors</button>' : '') +
        '<p class="note">Counts down as doses are logged (pen priming is not counted) and as new sensors start. su94r reminds you by day when it runs low or a refill is due.</p>');
    }
    html += card('<h2>This phone</h2><p>' + (role === 'family' ? (S.me && S.me.canLog ? 'A family member\'s phone: it reads and logs (the owner allowed it).' : 'A family member\'s phone: it reads; the owner can allow it to log.') : 'Your own phone: it reads and logs.') + (S.me && S.me.name ? ' Named “' + esc(S.me.name) + '” in su94r Mini.' : '') + '</p>' +
      '<button class="btn ghost" id="unlink">Unlink this phone</button>');
    html += '<p class="note" style="text-align:center">su94r · not a medical device. Readings come from LibreLinkUp and can be a few minutes behind.</p>';
    main(html);
  }

  // ---------- navigation and events ----------
  function show(tab) {
    if (['now', 'history', 'log', 'report', 'more'].indexOf(tab) < 0) tab = 'now';
    if (tab !== 'more') S.justLinked = false;
    S.tab = tab; store.set(K.tab, tab);
    document.querySelectorAll('#tabs button').forEach((b) => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    window.scrollTo(0, 0);
    ({ now: renderNow, history: renderHistory, log: renderLog, report: renderReport, more: renderMore })[tab]();
    if (tab === 'log' || tab === 'more') {
      const before = S.me && S.me.canLog;
      api('app/me').then((me) => { S.me = me; store.set(K.me, JSON.stringify(me)); if (S.tab === tab && me.canLog !== before) show(tab); }).catch(() => {});
    }
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); });
  $('people').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pid]'); if (!b) return;
    S.pid = b.dataset.pid; store.set(K.pid, S.pid); S.dayView = null;
    renderPeople(); show(S.tab);
  });
  $('main').addEventListener('click', (e) => {
    const t = e.target.closest('button,a'); if (!t) return;
    const d = t.dataset;
    if (d.range) { S.range = Number(d.range); store.set(K.range, d.range); renderNow(); }
    else if (d.days) { S.days = Number(d.days); store.set(K.days, d.days); S.dayView = null; renderHistory(); }
    else if (d.day) { S.dayView = d.day; renderHistory(); }
    else if (d.back) { S.dayView = null; renderHistory(); }
    else if (d.kind) { S.log.kind = d.kind; S.log.amount = 0; S.log.meal = null; renderLog(); }
    else if (d.step) setAmount(S.log.amount + Number(d.step) * (S.log.kind === 'carbs' ? 5 : 0.5));
    else if (d.amount) setAmount(Number(d.amount));
    else if (d.ago !== undefined) { S.log.ago = Number(d.ago); renderLog(); }
    else if (t.id === 'logBtn') askToLog();
    else if (t.id === 'micBtn') listen(t);
    else if (t.id === 'labAdd') editLab();
    else if (d.labDel) removeLab(d.labDel);
    else if (d.undo) undo(d.undo);
    else if (d.supply !== undefined) editSupply(d.supply);
    else if (d.treatG) { S.treatGrams = Number(d.treatG); renderNow(); }
    else if (t.id === 'treatBtn') askToTreat(Number(d.g));
    else if (t.id === 'ackBtn') sendAck();
    else if (t.id === 'pushOn') { t.disabled = true; pushOn().then(() => toast('Alerts are on. Send a test to hear one.')).catch((e) => toast(e.message)).then(() => { if (S.tab === 'more') renderMore(); }); }
    else if (t.id === 'pushOff') { t.disabled = true; pushOff().then(() => toast('App alerts are off on this phone.')).catch((e) => toast(e.message)).then(() => { if (S.tab === 'more') renderMore(); }); }
    else if (t.id === 'pushTest') { t.disabled = true; api('app/push/test', { method: 'POST', body: {} }).then(() => toast('Test sent. It should ring in a few seconds.')).catch((e) => toast(e.message)).then(() => { t.disabled = false; }); }
    else if (d.allow) {
      t.disabled = true;
      api('app/phones/allow', { method: 'POST', body: { id: d.allow, canLog: d.on === '1' } })
        .then(() => toast(d.on === '1' ? 'That phone can log now.' : 'That phone reads only now.'))
        .catch((e) => toast(e.message))
        .then(() => { if (S.tab === 'more') renderMore(); });
    }
    else if (t.id === 'print') window.print();
    else if (t.id === 'install' && S.installEvt) { S.installEvt.prompt(); S.installEvt = null; }
    else if (t.id === 'unlink') {
      sheet('<h3>Unlink this phone?</h3><p>It stops showing the glucose here. To link it again, scan a new code from su94r Mini.</p>',
        [['Unlink', 'btn warn', () => { closeSheet(); [K.token, K.role, K.ns, K.last, K.me].forEach((k) => store.del(k)); welcome(); }], ['Cancel', 'btn ghost', closeSheet]]);
    } else if (d.copy && navigator.clipboard) navigator.clipboard.writeText(d.copy).then(() => { t.textContent = 'Copied'; }).catch(() => {});
  });
  $('main').addEventListener('change', (e) => {
    if (e.target.id === 'otherKind' && e.target.value) { S.log.kind = e.target.value; S.log.amount = 0; S.log.meal = null; renderLog(); }
    if (e.target.id === 'photo' && e.target.files && e.target.files[0]) photo(e.target.files[0]);
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.tab === 'more') renderMore(); });

  async function boot() {
    const ackParam = /[?&]ack=([0-9a-f]{32})/.exec(location.search || '');
    if (ackParam) { S.pendingAck = '/night/ack?t=' + ackParam[1]; S.tab = 'now'; try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* fine */ } }
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => {
      const ack = e.data && e.data.ack;
      if (ack && /^\/night\/ack\?t=[0-9a-f]{32}$/.test(ack)) { S.pendingAck = ack; show('now'); }
    });
    try { await join(); } catch (e) { welcome(e.message); return; }
    if (!store.get(K.token)) { welcome(); return; }
    $('tabs').hidden = false;
    try { S.me = await api('app/me'); store.set(K.me, JSON.stringify(S.me)); } catch (e) {
      if (!store.get(K.token)) return;
      S.me = readJson(K.me);
    }
    renderPeople();
    await refreshLive();
    await refreshRecent();
    show(S.justLinked ? 'more' : S.tab);
    setInterval(refreshLive, 60e3);
    setInterval(refreshRecent, 120e3);
    setInterval(() => { status(); if (S.tab === 'now' && !$('sheet')) renderNow(); }, 15e3);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshLive(); refreshRecent(); } });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  boot();
})();
