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
import { labsForReport } from './labs.js';
import { findPatterns } from '../extension/patterns.js';
import { notesForReport } from './notes.js';
import { months as monthsOf } from './daily.js';
import { checksForReport } from './checks.js';

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
    lang: body.lang === 'es' ? 'es' : 'en',
  });
  return { ok: true, token, expiresAt };
}

/** The 14-day report numbers for one person, from the server's history and logged doses. */
export async function reportFor(pid, { history, doses, snapshot, labs = null, notes = null, daily = null, checks = null, tz = 'America/New_York', now = Date.now(), lang = 'en' }) {
  let person = null;
  try { person = (await snapshot()).people?.find((p) => p.pid === pid) || null; } catch { /* history only */ }
  const from = now - 14 * DAY;
  const points = history?.ready ? await history.range(pid, from, now + 60e3) : [];
  let events = [];
  try { if (doses?.ready) events = asMarkers(await doses.between(pid, from, now)); } catch { /* none */ }
  let monthRows = [];
  try { if (daily?.ready) monthRows = monthsOf(await daily.since(pid, new Date(now - 190 * DAY).toISOString().slice(0, 10))).slice(-6); } catch { /* without months */ }
  let checked = [];
  try { if (checks?.ready) checked = await checks.between(pid, now - 14 * DAY, now + 60e3, ['meter', 'ketone']); } catch { /* without */ }
  let noted = [];
  try { if (notes?.ready) noted = await notes.between(pid, from, now + 60e3); } catch { /* without notes */ }
  const low = person?.low ?? 70, high = person?.high ?? 180;
  const r = agp(points, events, { from, to: now, low, high });
  const mmol = person?.units === 'mmol/L';
  const found = findPatterns(points, events, { now, tz, low, high, fmt: (mg) => (mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg))), unit: mmol ? 'mmol/L' : 'mg/dL', lang, notes: noted });
  let lab = { labs: [], a1c: null };
  try { if (labs?.ready) lab = labsForReport(await labs.list(pid), now); } catch { /* without labs */ }
  return {
    person: person ? (person.firstName || person.name) : '',
    units: person?.units || 'mg/dL', low, high,
    from, to: now, days: r.days,
    readings: r.n, coverage: r.coverage, mean: r.mean, gmi: r.gmi, cv: r.cv,
    ranges: { veryLow: r.veryLow, low: r.low, inRange: r.inRange, high: r.high, veryHigh: r.veryHigh },
    profile: r.profile, insulin: r.insulin, meals: r.meals, labs: lab.labs, a1c: lab.a1c, patterns: found.patterns.map((p) => p.text), notes: notesForReport(noted), months: monthRows, checks: checksForReport(checked, points),
  };
}

/** The report numbers for a doctor link's token, or null when the link is unknown, removed or expired. */
export async function doctorData(screen, { history, doses, snapshot, labs = null, notes = null, daily = null, checks = null, tz, now = Date.now() }) {
  if (!screen || screen.kind !== 'doctor' || !screen.pid || Date.parse(screen.expires_at) <= now) return null;
  const lang = screen.lang === 'es' ? 'es' : 'en';
  return { ...(await reportFor(screen.pid, { history, doses, snapshot, labs, notes, daily, checks, tz, now, lang })), expiresAt: screen.expires_at, label: screen.name, lang };
}

/** The report as HTML in the browser: esc, pct, day, val, stat, chart and reportHtml(d). Plain ES2017,
 *  shared by the doctor's page and the phone app (workers/app-page.js). */
export const REPORT_SCRIPT = `function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function pct(x){return Math.round((x||0)*100)+'%'}
var RL='en';
var RES={'Glucose report':'Informe de glucosa','(14 days)':'(14 días)','For':'Para','always the latest 14 days':'siempre los últimos 14 días','link expires':'el enlace vence','Always the latest 14 days':'Siempre los últimos 14 días','From su94r (FreeStyle Libre via LibreLinkUp). Not a medical device.':'De su94r (FreeStyle Libre vía LibreLinkUp). No es un dispositivo médico.','Average glucose':'Glucosa promedio','GMI':'GMI','estimated from the average':'estimado a partir del promedio','Variability (CV)':'Variabilidad (CV)','target ≤36%':'meta ≤36%','Sensor data':'Datos del sensor','below the 70% advised for a reliable report':'menos del 70% recomendado para un informe confiable','of the period':'del periodo','Time in ranges':'Tiempo en rangos','Very high (&gt;250)':'Muy alta (&gt;250)','target &lt;5%':'meta &lt;5%','High':'Alta','target &lt;25% with very high':'meta &lt;25% con muy alta','In range':'En rango','target &gt;70%':'meta &gt;70%','Low':'Baja','target &lt;4% with very low':'meta &lt;4% con muy baja','Very low (&lt;54)':'Muy baja (&lt;54)','target &lt;1%':'meta &lt;1%','Glucose by time of day':'Glucosa según la hora del día','Median line, 25–75% band and 5–95% band of all days; target range shaded.':'Línea de la mediana, franja del 25–75% y del 5–95% de todos los días; el rango meta está sombreado.','Patterns':'Patrones','What repeated in these 14 days. It describes; it does not advise.':'Lo que se repitió en estos 14 días. Describe; no aconseja.','Logged insulin and meals':'Insulina y comidas registradas','Insulin':'Insulina','Doses':'Dosis','Units per day':'Unidades por día','No insulin logged on the server in this period.':'No hay insulina registrada en el servidor en este periodo.','meals logged. Logged markers are what was entered and may be incomplete.':'comidas registradas. Los registros son lo que se anotó y pueden estar incompletos.','Lab results (last 12 months)':'Resultados de laboratorio (últimos 12 meses)','Latest A1c':'A1c más reciente','GMI over these 14 days':'GMI de estos 14 días','not enough readings':'faltan lecturas','They often differ by a few tenths: GMI covers 14 days, A1c about 3 months.':'Suelen diferir por unas décimas: el GMI abarca 14 días y la A1c unos 3 meses.','Date':'Fecha','Test':'Prueba','Result':'Resultado','Typed in by the patient.':'Anotado por el paciente.','Notes':'Notas','Meter checks':'Lecturas del glucómetro','Ketones':'Cetonas','Time':'Hora','Meter':'Glucómetro','Sensor':'Sensor','Difference':'Diferencia','checks compared with the sensor; within 20%:':'lecturas comparadas con el sensor; dentro del 20%:','average difference':'diferencia promedio','urine':'orina','Month by month':'Mes a mes','Month':'Mes','Days':'Días','GMI from the average of each month (days with 8+ hours of readings).':'GMI del promedio de cada mes (días con 8+ horas de lecturas).','rapid':'rápida','short':'regular','intermediate':'NPH','basal':'acción prolongada','mix':'premezclada'};
function L(s){return RL==='es'&&RES[s]?RES[s]:s}
function day(t){return new Date(t).toLocaleDateString(RL==='es'?'es-US':'en-US',{month:'short',day:'numeric',year:'numeric'})}
function val(mg,u){return u==='mmol/L'?(mg/18.0182).toFixed(1):String(Math.round(mg))}
function stat(l,v,n){return '<div class="stat"><div class="v">'+v+'</div><div class="l">'+l+'</div>'+(n?'<div class="n">'+n+'</div>':'')+'</div>'}
function chart(d){
  var W=760,H=260,pl=34,pr=8,pt=10,pb=24,lo=40,hi=300;
  var x=function(i){return pl+(i/95)*(W-pl-pr)},y=function(v){return pt+(1-(Math.min(hi,Math.max(lo,v))-lo)/(hi-lo))*(H-pt-pb)};
  var s='<svg class="agp" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+L('Glucose by time of day')+'">';
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
function reportHtml(d,lang){
  RL=lang==='es'?'es':'en';
  var r=d.ranges,u=d.units;
  var ins=Object.keys(d.insulin||{}).map(function(k){var v=d.insulin[k];return '<tr><td>'+esc(L(k))+'</td><td class="num">'+v.doses+'</td><td class="num">'+(v.withAmount?(v.units/d.days).toFixed(1):'—')+'</td></tr>'}).join('');
  return '<div class="head"><div><h1>'+L('Glucose report')+'</h1><div class="muted">'+esc(d.person)+' · '+day(d.from)+' – '+day(d.to)+' '+L('(14 days)')+' · '+esc(u)+'</div></div>'+
    '<div class="muted small">'+(d.label?L('For')+' '+esc(d.label)+' · '+L('always the latest 14 days')+' · '+L('link expires')+' '+day(d.expiresAt):L('Always the latest 14 days'))+'<br>'+L('From su94r (FreeStyle Libre via LibreLinkUp). Not a medical device.')+'</div></div>'+
    '<div class="stats">'+stat(L('Average glucose'),d.mean!=null?val(d.mean,u)+' '+esc(u):'—')+stat(L('GMI'),d.gmi!=null?d.gmi.toFixed(1)+'%':'—',L('estimated from the average'))+stat(L('Variability (CV)'),d.cv!=null?d.cv.toFixed(1)+'%':'—',L('target ≤36%'))+stat(L('Sensor data'),pct(d.coverage),d.coverage<0.7?L('below the 70% advised for a reliable report'):L('of the period'))+'</div>'+
    '<h2>'+L('Time in ranges')+'</h2><div class="ranges"><div class="col">'+[['vh',r.veryHigh],['hh',r.high],['in',r.inRange],['lo',r.low],['vl',r.veryLow]].map(function(a){return '<span class="seg '+a[0]+'" style="flex-grow:'+(a[1]||0)+'"></span>'}).join('')+'</div>'+
    '<table><tr><td>'+L('Very high (&gt;250)')+'</td><td class="num">'+pct(r.veryHigh)+'</td><td class="muted small">'+L('target &lt;5%')+'</td></tr><tr><td>'+L('High')+'</td><td class="num">'+pct(r.high)+'</td><td class="muted small">'+L('target &lt;25% with very high')+'</td></tr><tr><td>'+L('In range')+' ('+val(d.low,u)+'–'+val(d.high,u)+')</td><td class="num">'+pct(r.inRange)+'</td><td class="muted small">'+L('target &gt;70%')+'</td></tr><tr><td>'+L('Low')+'</td><td class="num">'+pct(r.low)+'</td><td class="muted small">'+L('target &lt;4% with very low')+'</td></tr><tr><td>'+L('Very low (&lt;54)')+'</td><td class="num">'+pct(r.veryLow)+'</td><td class="muted small">'+L('target &lt;1%')+'</td></tr></table></div>'+
    '<h2>'+L('Glucose by time of day')+'</h2><p class="muted small">'+L('Median line, 25–75% band and 5–95% band of all days; target range shaded.')+'</p>'+chart(d)+
    (d.patterns&&d.patterns.length?'<h2>'+L('Patterns')+'</h2><ul class="pat">'+d.patterns.map(function(t){return '<li>'+esc(t)+'</li>'}).join('')+'</ul><p class="muted small">'+L('What repeated in these 14 days. It describes; it does not advise.')+'</p>':'')+
    '<h2>'+L('Logged insulin and meals')+'</h2>'+(ins?'<table><tr><th>'+L('Insulin')+'</th><th class="num">'+L('Doses')+'</th><th class="num">'+L('Units per day')+'</th></tr>'+ins+'</table>':'<p class="muted">'+L('No insulin logged on the server in this period.')+'</p>')+
    '<p class="muted small">'+(d.meals?d.meals.count:0)+' '+L('meals logged. Logged markers are what was entered and may be incomplete.')+'</p>'+
    monthsHtml(d)+labsHtml(d)+checksHtml(d)+notesHtml(d);
}
function checksHtml(d){
  var c=d.checks;if(!c||(!c.meters.length&&!c.ketones.length))return '';
  var dt=function(t){return new Date(t).toLocaleString(RL==='es'?'es-US':'en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})};
  var h='';
  if(c.meters.length){h+='<h2>'+L('Meter checks')+'</h2>'+(c.compared?'<p class="small">'+c.compared+' '+L('checks compared with the sensor; within 20%:')+' <b>'+c.within+'</b>'+(c.mard!=null?' · '+L('average difference')+' '+c.mard+'%':'')+'</p>':'')+'<table><tr><th>'+L('Time')+'</th><th class="num">'+L('Meter')+'</th><th class="num">'+L('Sensor')+'</th><th class="num">'+L('Difference')+'</th></tr>'+c.meters.map(function(m){return '<tr><td class="muted small">'+dt(m.t)+'</td><td class="num">'+val(m.mg,d.units)+'</td><td class="num">'+(m.cgm!=null?val(m.cgm,d.units):'—')+'</td><td class="num"'+(m.off?' style="color:#cf222e"':'')+'>'+(m.pct!=null?(m.pct>0?'+':'')+m.pct+'%':'—')+'</td></tr>'}).join('')+'</table>'}
  if(c.ketones.length){h+='<h2>'+L('Ketones')+'</h2><table>'+c.ketones.map(function(k){return '<tr><td class="muted small">'+dt(k.t)+'</td><td class="num"'+(k.level==='high'||k.level==='urgent'?' style="color:#cf222e"':'')+'>'+(k.unit==='urine'?esc(k.label)+' ('+L('urine')+')':k.value+' mmol/L')+'</td></tr>'}).join('')+'</table>'}
  return h;
}
function monthsHtml(d){
  var m=d.months;if(!m||m.length<2)return '';
  return '<h2>'+L('Month by month')+'</h2><table><tr><th>'+L('Month')+'</th><th class="num">'+L('Days')+'</th><th class="num">GMI</th><th class="num">'+L('In range')+'</th></tr>'+m.map(function(x){return '<tr><td>'+new Date(x.month+'-15T12:00:00Z').toLocaleDateString(RL==='es'?'es-US':'en-US',{month:'long',year:'numeric'})+'</td><td class="num">'+x.days+'</td><td class="num">'+x.gmi.toFixed(1)+'%</td><td class="num">'+pct(x.inRange)+'</td></tr>'}).join('')+'</table><p class="muted small">'+L('GMI from the average of each month (days with 8+ hours of readings).')+'</p>';
}
function notesHtml(d){
  var n=d.notes;if(!n||!n.count)return '';
  var TW=RL==='es'?{exercise:'ejercicio',stress:'estrés',sick:'enfermedad',alcohol:'alcohol',period:'menstruación',travel:'viaje','eating-out':'comer fuera'}:{exercise:'exercise',stress:'stress',sick:'sick',alcohol:'alcohol',period:'period',travel:'travel','eating-out':'eating out'};
  var tags=Object.keys(n.tags).sort(function(a,b){return n.tags[b]-n.tags[a]}).map(function(k){return esc(TW[k]||k)+' ×'+n.tags[k]}).join(' · ');
  return '<h2>'+L('Notes')+'</h2>'+(tags?'<p class="small">'+tags+'</p>':'')+'<table>'+n.recent.map(function(x){return '<tr><td class="muted small" style="white-space:nowrap">'+new Date(x.t).toLocaleString(RL==='es'?'es-US':'en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</td><td>'+esc(x.text)+(x.tags.length?' <span class="muted small">'+x.tags.map(function(k){return esc(TW[k]||k)}).join(', ')+'</span>':'')+'</td></tr>'}).join('')+'</table><p class="muted small">'+L('Typed in by the patient.')+'</p>';
}
function labsHtml(d){
  if(!d.labs||!d.labs.length)return '';
  var cmp=d.a1c?'<p class="small">'+L('Latest A1c')+' <b>'+d.a1c.value.toFixed(1)+'%</b> ('+day(d.a1c.takenOn+'T12:00:00')+'). '+L('GMI over these 14 days')+': <b>'+(d.gmi!=null?d.gmi.toFixed(1)+'%':L('not enough readings'))+'</b>. '+L('They often differ by a few tenths: GMI covers 14 days, A1c about 3 months.')+'</p>':'';
  return '<h2>'+L('Lab results (last 12 months)')+'</h2>'+cmp+'<table><tr><th>'+L('Date')+'</th><th>'+L('Test')+'</th><th class="num">'+L('Result')+'</th></tr>'+d.labs.map(function(l){return '<tr><td>'+day(l.takenOn+'T12:00:00')+'</td><td>'+esc(l.name)+'</td><td class="num">'+esc(String(l.value))+(l.unit?' '+esc(l.unit):'')+'</td></tr>'}).join('')+'</table><p class="muted small">'+L('Typed in by the patient.')+'</p>';
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
<div class="bar"><span class="muted small" id="shared">Shared from su94r Mini · read-only</span><button type="button" id="printBtn" onclick="print()">Print or save as PDF</button></div>
<main id="r" class="report"><p class="muted" id="loading">Loading…</p></main>
<script>
var token = location.pathname.split('/').filter(Boolean).pop();
${REPORT_SCRIPT}fetch('/doctor/data',{cache:'no-store',headers:{Authorization:'Bearer '+token}}).then(function(res){return res.json().then(function(j){return{ok:res.ok,j:j}})}).then(function(o){
  var d=o.j;
  var esNav=/^es/i.test(navigator.language||'');
  if(!o.ok){document.getElementById('r').outerHTML=esNav?'<div class="err"><h1>Este enlace terminó</h1><p class="muted">Venció o lo quitaron. Pide uno nuevo.</p></div>':'<div class="err"><h1>This link has ended</h1><p class="muted">It expired or was removed. Ask for a new one.</p></div>';return}
  if(d.lang==='es'){document.documentElement.lang='es';document.getElementById('shared').textContent='Compartido desde su94r Mini · solo lectura';document.getElementById('printBtn').textContent='Imprimir o guardar como PDF'}
  document.getElementById('r').innerHTML=reportHtml(d,d.lang);
  document.title=(d.lang==='es'?'Informe de glucosa · ':'Glucose report · ')+(d.person||'')+' · '+day(d.to);
}).catch(function(){document.getElementById('r').innerHTML=/^es/i.test(navigator.language||'')?'<p class="muted">No se pudo cargar el informe. Intenta en un minuto.</p>':'<p class="muted">Could not load the report. Try again in a minute.</p>'});
</script>
</body></html>`;
}
