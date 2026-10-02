// A live link for the doctor: one private address that always shows the current 14-day glucose
// report (the standard AGP: time in ranges, GMI, CV, percentiles by time of day, logged insulin
// and meals), read-only, from the server's own history (history.js). It expires (30 days by
// default) and is removed like any screen in su94r Mini. It reads nothing else: not the live
// glucose, not the doses one by one, not the alerts.
//
// Kept in su94r_screens as kind 'doctor' with the person (pid) and the expiry (expires_at).
//
// Routes:
//   POST doctor/new?key=<owner>     { name, days, pid } → { token, expiresAt }
//   GET  doctor/data                 Authorization: Bearer <token> → the report numbers
//   page /r/<token>                  served by su94r-proxy (doctorPage below)

import { sha256, randomToken } from './screens.js';
import { agp } from '../extension/agp.js';
import { asMarkers } from './doses.js';

const DAY = 864e5;
const clean = (s, max = 40) => String(s || '').replace(/[^\p{L}\p{N} '.,()-]/gu, '').trim().slice(0, max);

export async function doctorNew(request, store, snapshot) {
  const body = await request.json().catch(() => ({}));
  const days = Math.min(90, Math.max(1, Number(body.days) || 30));
  let pid = String(body.pid || '');
  if (!pid) { try { pid = (await snapshot()).people?.[0]?.pid || ''; } catch { /* below */ } }
  if (!/^[\w-]{1,80}$/.test(pid)) return { ok: false, error: 'No one to report on yet.' };
  const token = randomToken();
  const now = Date.now();
  const expiresAt = new Date(now + days * DAY).toISOString();
  await store.insert({
    id: crypto.randomUUID(), secret_hash: await sha256(randomToken()), token_hash: await sha256(token),
    kind: 'doctor', pid, name: clean(body.name) || 'Doctor', claimed_at: new Date(now).toISOString(), expires_at: expiresAt,
  });
  return { ok: true, token, expiresAt };
}

/** The 14-day report numbers for one person, from the server's history and logged doses. */
export async function reportFor(pid, { history, doses, snapshot, now = Date.now() }) {
  let person = null;
  try { person = (await snapshot()).people?.find((p) => p.pid === pid) || null; } catch { /* history only */ }
  const from = now - 14 * DAY;
  const points = history?.ready ? await history.range(pid, from, now + 60e3) : [];
  let events = [];
  try { if (doses?.ready) events = asMarkers(await doses.between(pid, from, now)); } catch { /* none */ }
  const low = person?.low ?? 70, high = person?.high ?? 180;
  const r = agp(points, events, { from, to: now, low, high });
  return {
    person: person ? (person.firstName || person.name) : '',
    units: person?.units || 'mg/dL', low, high,
    from, to: now, days: r.days,
    readings: r.n, coverage: r.coverage, mean: r.mean, gmi: r.gmi, cv: r.cv,
    ranges: { veryLow: r.veryLow, low: r.low, inRange: r.inRange, high: r.high, veryHigh: r.veryHigh },
    profile: r.profile, insulin: r.insulin, meals: r.meals,
  };
}

/** The report numbers for a doctor link's token, or null when the link is unknown, removed or expired. */
export async function doctorData(screen, { history, doses, snapshot, now = Date.now() }) {
  if (!screen || screen.kind !== 'doctor' || !screen.pid || Date.parse(screen.expires_at) <= now) return null;
  return { ...(await reportFor(screen.pid, { history, doses, snapshot, now })), expiresAt: screen.expires_at, label: screen.name };
}

/** The report as HTML in the browser: esc, pct, day, val, stat, chart and reportHtml(d). Plain ES2017,
 *  shared by the doctor's page and the phone app (workers/app-page.js). */
export const REPORT_SCRIPT = `function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function pct(x){return Math.round((x||0)*100)+'%'}
function day(t){return new Date(t).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
function val(mg,u){return u==='mmol/L'?(mg/18.0182).toFixed(1):String(Math.round(mg))}
function stat(l,v,n){return '<div class="stat"><div class="v">'+v+'</div><div class="l">'+l+'</div>'+(n?'<div class="n">'+n+'</div>':'')+'</div>'}
function chart(d){
  var W=760,H=260,pl=34,pr=8,pt=10,pb=24,lo=40,hi=300;
  var x=function(i){return pl+(i/95)*(W-pl-pr)},y=function(v){return pt+(1-(Math.min(hi,Math.max(lo,v))-lo)/(hi-lo))*(H-pt-pb)};
  var s='<svg class="agp" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Glucose percentiles by time of day">';
  s+='<rect x="'+pl+'" y="'+y(d.high)+'" width="'+(W-pl-pr)+'" height="'+(y(d.low)-y(d.high))+'" fill="rgba(26,127,55,.10)"/>';
  [d.low,d.high,250].forEach(function(v){s+='<line x1="'+pl+'" x2="'+(W-pr)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#d0d7de"/><text x="2" y="'+(y(v)+4)+'">'+val(v,d.units)+'</text>'});
  [0,24,48,72,95].forEach(function(i){var h=Math.round(i/4)%24;s+='<text x="'+(x(i)-10)+'" y="'+(H-6)+'">'+(h===0?'12a':h<12?h+'a':h===12?'12p':(h-12)+'p')+'</text>'});
  var p=d.profile.map(function(q,i){return q&&{i:i,q:q}}).filter(Boolean);
  if(p.length>2){
    var band=function(a,b,fill){var top=p.map(function(o){return x(o.i)+','+y(o.q[b])}).join(' '),bot=p.slice().reverse().map(function(o){return x(o.i)+','+y(o.q[a])}).join(' ');s+='<polygon points="'+top+' '+bot+'" fill="'+fill+'"/>'};
    band('p5','p95','rgba(9,105,218,.12)');band('p25','p75','rgba(9,105,218,.28)');
    s+='<polyline points="'+p.map(function(o){return x(o.i)+','+y(o.q.p50)}).join(' ')+'" fill="none" stroke="#0969da" stroke-width="2.5"/>';
  }
  return s+'</svg>';
}
function reportHtml(d){
  var r=d.ranges,u=d.units;
  var ins=Object.keys(d.insulin||{}).map(function(k){var v=d.insulin[k];return '<tr><td>'+esc(k)+'</td><td class="num">'+v.doses+'</td><td class="num">'+(v.withAmount?(v.units/d.days).toFixed(1):'—')+'</td></tr>'}).join('');
  return     '<div class="head"><div><h1>Glucose report</h1><div class="muted">'+esc(d.person)+' · '+day(d.from)+' to '+day(d.to)+' (14 days) · '+esc(u)+'</div></div>'+
    '<div class="muted small">'+(d.label?'For '+esc(d.label)+' · always the latest 14 days · link expires '+day(d.expiresAt):'Always the latest 14 days')+'<br>From su94r (FreeStyle Libre via LibreLinkUp). Not a medical device.</div></div>'+
    '<div class="stats">'+stat('Average glucose',d.mean!=null?val(d.mean,u)+' '+esc(u):'—')+stat('GMI',d.gmi!=null?d.gmi.toFixed(1)+'%':'—','estimated from the average')+stat('Variability (CV)',d.cv!=null?d.cv.toFixed(1)+'%':'—','target ≤36%')+stat('Sensor data',pct(d.coverage),d.coverage<0.7?'below the 70% advised for a reliable report':'of the period')+'</div>'+
    '<h2>Time in ranges</h2><div class="ranges"><div class="col">'+[['vh',r.veryHigh],['hh',r.high],['in',r.inRange],['lo',r.low],['vl',r.veryLow]].map(function(a){return '<span class="seg '+a[0]+'" style="flex-grow:'+(a[1]||0)+'"></span>'}).join('')+'</div>'+
    '<table><tr><td>Very high (&gt;250)</td><td class="num">'+pct(r.veryHigh)+'</td><td class="muted small">target &lt;5%</td></tr><tr><td>High</td><td class="num">'+pct(r.high)+'</td><td class="muted small">target &lt;25% with very high</td></tr><tr><td>In range ('+val(d.low,u)+'–'+val(d.high,u)+')</td><td class="num">'+pct(r.inRange)+'</td><td class="muted small">target &gt;70%</td></tr><tr><td>Low</td><td class="num">'+pct(r.low)+'</td><td class="muted small">target &lt;4% with very low</td></tr><tr><td>Very low (&lt;54)</td><td class="num">'+pct(r.veryLow)+'</td><td class="muted small">target &lt;1%</td></tr></table></div>'+
    '<h2>Glucose by time of day</h2><p class="muted small">Median line, 25–75% band and 5–95% band of all days; target range shaded.</p>'+chart(d)+
    '<h2>Logged insulin and meals</h2>'+(ins?'<table><tr><th>Insulin</th><th class="num">Doses</th><th class="num">Units per day</th></tr>'+ins+'</table>':'<p class="muted">No insulin logged on the server in this period.</p>')+
    '<p class="muted small">'+(d.meals?d.meals.count:0)+' meals logged. Logged markers are what was entered and may be incomplete.</p>';
}
`;

/** The doctor's page. Self-contained (no outside scripts); light and printable; plain ES2017. */
export function doctorPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Glucose report</title>
<style>
:root{--fg:#1f2328;--muted:#57606a;--line:#d0d7de;--in:#1a7f37;--h:#d4a72c;--vh:#bc4c00;--l:#cf222e;--vl:#82071e;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0;background:#f6f8fa;color:var(--fg);font:14px/1.5 "Segoe UI",Roboto,Arial,Helvetica,sans-serif}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 16px;background:#fff;border-bottom:1px solid var(--line)}
.bar button{font:inherit;padding:6px 12px;border:1px solid #1f883d;border-radius:6px;background:#1f883d;color:#fff;font-weight:600;cursor:pointer}
.report{max-width:820px;margin:16px auto;padding:24px 28px;background:#fff;border:1px solid var(--line);border-radius:8px}
h1{margin:0;font-size:22px}h2{font-size:15px;margin:24px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}.small{font-size:12px}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid var(--fg);padding-bottom:10px;flex-wrap:wrap}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}@media(max-width:620px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.v{font-size:20px;font-weight:700}.l{font-size:12px;color:var(--muted)}.n{font-size:11px;color:var(--muted)}
.ranges{display:flex;gap:22px;align-items:stretch}.col{display:flex;flex-direction:column;width:46px;min-height:180px;border-radius:6px;overflow:hidden;border:1px solid var(--line)}
.seg{display:block;flex-basis:0}.vh{background:var(--vh)}.hh{background:var(--h)}.in{background:var(--in)}.lo{background:var(--l)}.vl{background:var(--vl)}
table{border-collapse:collapse}td,th{padding:5px 10px 5px 0;text-align:left}.num{text-align:right;font-weight:600}
.agp{width:100%;height:auto;display:block}.agp text{fill:var(--muted);font-size:11px}
.err{max-width:620px;margin:40px auto;padding:20px;background:#fff;border:1px solid var(--line);border-radius:8px}
@media print{html,body{background:#fff}.bar{display:none}.report{border:0;margin:0;max-width:none}}
</style></head>
<body>
<div class="bar"><span class="muted small">Shared from su94r Mini · read-only</span><button type="button" onclick="print()">Print or save as PDF</button></div>
<main id="r" class="report"><p class="muted">Loading…</p></main>
<script>
var token = location.pathname.split('/').filter(Boolean).pop();
${REPORT_SCRIPT}fetch('/doctor/data',{cache:'no-store',headers:{Authorization:'Bearer '+token}}).then(function(res){return res.json().then(function(j){return{ok:res.ok,j:j}})}).then(function(o){
  var d=o.j;
  if(!o.ok){document.getElementById('r').outerHTML='<div class="err"><h1>This link has ended</h1><p class="muted">It expired or was removed. Ask for a new one.</p></div>';return}
  document.title='Glucose report · '+(d.person||'')+' · '+day(d.to);
  document.getElementById('r').innerHTML=reportHtml(d);
}).catch(function(){document.getElementById('r').innerHTML='<p class="muted">Could not load the report. Try again in a minute.</p>'});
</script>
</body></html>`;
}
