// The emergency card: a page anyone can open from a QR code (a wallet card, the phone's lock
// screen, a sticker on the meter case) when the person cannot speak for themselves. It says who
// they are and what they wrote (diabetes, insulin, allergies), what to do for a low (their own
// low plan and the standard first aid), the glucose now if they allow it, and whom to call.
// Opening it tells the person and their family (at most every 30 minutes), unless they turn
// that off.
//
// Kept in su94r_screens as kind 'emergency' (one card link at a time: a new one turns the old
// one off; it does not expire), the details on the night row (su94r_night.emergency).
//
// Routes (the owner key from su94r Mini; the owner's phone uses the same as app/emergency…):
//   GET  emergency?key=                 { card, link: { id, since, lastSeen } | null }
//   POST emergency/save?key=            { note, contacts: [{ name, phone }], glucose, tell, lang }
//   POST emergency/new?key=             { pid } → { token } (the old card link stops working)
//   POST emergency/remove?key=          the card link stops working
//   GET  emergency/data                 Authorization: Bearer <token> → what the page shows
//   page /e/<token>                     served by su94r-proxy (emergencyPage below)

import { sha256, randomToken, screenFor } from './screens.js';
import { NIGHT_DEFAULTS } from './night.js';

const MIN = 60e3;
const TELL_EVERY_MS = 30 * MIN;
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const phoneOk = (s) => /^\+?[0-9 ().-]{7,20}$/.test(s) && (s.match(/\d/g) || []).length >= 7;

/** The card as kept, with defaults: { note, contacts, glucose, tell, lang }. */
export function cardView(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    note: String(c.note || ''),
    contacts: Array.isArray(c.contacts) ? c.contacts.filter((x) => x?.phone).slice(0, 3) : [],
    glucose: c.glucose !== false, tell: c.tell !== false, lang: c.lang === 'es' ? 'es' : 'en',
  };
}

/** What su94r Mini or the phone sent, checked: { card } or { error, name }. */
export function cardFrom(body) {
  const contacts = [];
  for (const c of Array.isArray(body?.contacts) ? body.contacts.slice(0, 3) : []) {
    const name = clean(c?.name, 40), phone = clean(c?.phone, 20);
    if (!name && !phone) continue;
    if (!phoneOk(phone)) return { error: 'phone', name: name || phone || '?' };
    contacts.push({ name: name || phone, phone });
  }
  return { card: { note: clean(body?.note, 300), contacts, glucose: body?.glucose !== false, tell: body?.tell !== false, lang: body?.lang === 'es' ? 'es' : 'en' } };
}

/** emergency, emergency/save, emergency/new, emergency/remove (the caller checked it is the owner). */
export async function emergencyManage(sub, request, { screens, night, json, snapshot, es = false }) {
  const T = (en, sp) => (es ? sp : en);
  if (!night?.ready || !screens?.ready) return json({ error: 'not configured' }, 503);
  const links = async () => (await screens.list()).filter((s) => s.kind === 'emergency');
  if (sub === 'emergency') {
    const row = await night.get();
    const link = (await links())[0];
    return json({ card: cardView(row.emergency), link: link ? { id: link.id, since: link.created_at, lastSeen: link.last_seen || null } : null });
  }
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const body = await request.json().catch(() => ({}));
  if (sub === 'emergency/save') {
    const r = cardFrom(body);
    if (r.error) return json({ ok: false, error: T(`The phone number for ${r.name} does not look right.`, `El teléfono de ${r.name} no parece correcto.`) }, 400);
    await night.patch({ emergency: r.card });
    return json({ ok: true, card: r.card });
  }
  if (sub === 'emergency/new') {
    const people = await snapshot().then((s) => s.people || []).catch(() => []);
    const pid = (people.find((p) => p.pid === String(body.pid || '')) || people[0])?.pid || '';
    if (!/^[\w-]{1,80}$/.test(pid)) return json({ ok: false, error: T('No one to make a card for yet.', 'Todavía no hay nadie para quien hacer la tarjeta.') }, 400);
    for (const old of await links()) await screens.update(old.id, { revoked: true });
    const token = randomToken();
    const now = Date.now();
    await screens.insert({
      id: crypto.randomUUID(), secret_hash: await sha256(randomToken()), token_hash: await sha256(token),
      kind: 'emergency', pid, name: 'Emergency card', claimed_at: new Date(now).toISOString(), expires_at: new Date(now + 10 * 365 * 864e5).toISOString(),
    });
    return json({ ok: true, token });
  }
  if (sub === 'emergency/remove') {
    for (const old of await links()) await screens.update(old.id, { revoked: true });
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

/** What the card page shows, or null when the token is not a card link (or was turned off). */
export async function emergencyData(screen, { night, snapshot, now = Date.now() }) {
  if (!screen || screen.kind !== 'emergency' || !screen.pid) return null;
  const row = night?.ready ? await night.get().catch(() => null) : null;
  const card = cardView(row?.emergency);
  let person = null;
  try { person = (await snapshot()).people?.find((p) => p.pid === screen.pid) || null; } catch { /* the card without the glucose */ }
  const l = card.glucose ? person?.latest : null;
  return {
    name: person?.name || person?.firstName || '', firstName: person?.firstName || person?.name || '',
    note: card.note, contacts: card.contacts, lang: card.lang, tells: card.tell,
    units: person?.units || 'mg/dL', low: row?.low_mgdl ?? person?.low ?? 70,
    glucoseShared: card.glucose,
    glucose: l ? { mg: l.mg, trend: l.trend, t: l.t, minutes: Math.max(0, Math.round((now - l.t) / MIN)) } : null,
    plan: { grams: row?.treat_grams ?? NIGHT_DEFAULTS.treat_grams, minutes: row?.treat_minutes ?? NIGHT_DEFAULTS.treat_minutes, text: row?.treat_plan || '' },
    at: now,
  };
}

/**
 * emergency/* routes; null when the path is not one. `notify(row, role, msg)` reaches the owner
 * and the family (night.js alertFanOut) when someone opens the card.
 */
export async function emergencyRoute(path, request, url, { screens, night, json, keyOk, snapshot, notify = null, now = () => Date.now() }) {
  if (path !== 'emergency' && !path.startsWith('emergency/')) return null;
  if (!screens.ready) return json({ error: 'not configured' }, 503);
  if (path === 'emergency/data') {
    const screen = await screenFor(request, screens, '');
    const d = await emergencyData(screen, { night, snapshot, now: now() });
    if (!d) return json({ error: 'unauthorized' }, 401);
    // screenFor returns the row as it was: last_seen is the previous opening.
    const preview = request.headers.get('x-su94r-preview') === '1';
    const before = screen.last_seen ? Date.parse(screen.last_seen) : 0;
    if (d.tells && !preview && notify && now() - before >= TELL_EVERY_MS) {
      const row = await night.get().catch(() => null);
      if (row) {
        const at = new Date(now()).toLocaleTimeString('en-US', { timeZone: row.time_zone || 'America/New_York', hour: 'numeric', minute: '2-digit' });
        const msg = {
          title: d.firstName ? `${d.firstName}'s emergency card was opened` : 'The emergency card was opened',
          message: `Someone opened the emergency card at ${at}. Call to check on ${d.firstName || 'them'}.`,
          priority: 5, tags: ['sos'],
          es: { title: d.firstName ? `Abrieron la tarjeta de emergencia de ${d.firstName}` : 'Abrieron la tarjeta de emergencia', message: `Alguien abrió la tarjeta de emergencia a las ${at}. Llama para saber cómo está${d.firstName ? ` ${d.firstName}` : ''}.` },
        };
        await Promise.allSettled([notify(row, 'me', msg), notify(row, 'family', msg)]);
      }
    }
    return json(d);
  }
  if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);
  return emergencyManage(path, request, { screens, night, json, snapshot });
}

/** The card page. Self-contained (no outside scripts), large type, English and Spanish; plain ES2017. */
export function emergencyPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#b42318"><title>Medical information</title>
<style>
:root{--red:#b42318;--fg:#1f2328;--muted:#57606a;--line:#d0d7de;--ok:#1a7f37;--warn:#bc4c00;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:var(--fg);font:18px/1.45 "Segoe UI",Roboto,Arial,Helvetica,sans-serif}
header{background:var(--red);color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px}
header h1{margin:0;font-size:22px;letter-spacing:.02em}
header button{font:inherit;font-size:15px;padding:6px 12px;border:1px solid #fff;border-radius:8px;background:transparent;color:#fff;cursor:pointer}
main{max-width:640px;margin:0 auto;padding:16px}
.name{font-size:30px;font-weight:700;margin:4px 0 2px}.note{font-size:20px;margin:0 0 12px}
.g{border:2px solid var(--line);border-radius:12px;padding:12px 14px;margin:12px 0;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.g .v{font-size:44px;font-weight:800;line-height:1}.g .l{color:var(--muted);font-size:16px}
.g.low{border-color:var(--red);background:#fff1f0}.g.low .v{color:var(--red)}.g.high{border-color:var(--warn)}.g.high .v{color:var(--warn)}.g.in .v{color:var(--ok)}.g.old .v{color:var(--muted)}
h2{font-size:20px;margin:20px 0 6px;padding-bottom:4px;border-bottom:2px solid var(--line)}
ol{margin:6px 0 0;padding-left:24px}li{margin:4px 0}
.plan{background:#f6f8fa;border-radius:8px;padding:8px 12px;margin-top:8px}
a.call{display:block;text-align:center;text-decoration:none;font-weight:700;font-size:20px;padding:14px;border-radius:12px;margin:10px 0;border:2px solid var(--fg);color:var(--fg)}
a.call.sos{background:var(--red);border-color:var(--red);color:#fff;font-size:24px}
.muted{color:var(--muted);font-size:14px}.err{padding:24px 16px;text-align:center}
@media print{header button,a.call.sos{display:none}}
</style></head>
<body>
<header><h1 id="h">Medical information</h1><button type="button" id="lang">Español</button></header>
<main id="m"><p class="muted">Loading…</p></main>
<script>
var token = location.pathname.split('/').filter(Boolean).pop();
var preview = location.hash === '#preview';
var D = null, LANG = null;
var ES = {'Medical information':'Información médica','Glucose now':'Glucosa ahora','min ago':'min','just now':'ahora','LOW':'BAJA','HIGH':'ALTA',
 'If they seem low, are awake and can swallow':'Si parece tener la glucosa baja, está despierto y puede tragar',
 'If they are not awake, cannot swallow or have a seizure':'Si no está despierto, no puede tragar o tiene una convulsión',
 'Call 911.':'Llama al 911.','Do not put food or drink in their mouth.':'No le pongas comida ni bebida en la boca.',
 'If there is a glucagon kit or nasal glucagon, use it as its label says.':'Si hay un kit de glucagón o glucagón nasal, úsalo como dice la etiqueta.',
 'Turn them on their side and stay with them.':'Ponlo de lado y quédate con esa persona.',
 'Call 911':'Llamar al 911','Call':'Llamar a','Whom to call':'A quién llamar','Their plan:':'Su plan:',
 'Opening this card told their family.':'Al abrir esta tarjeta se avisó a su familia.',
 'From su94r. Not a medical device. The glucose comes from their FreeStyle Libre sensor and can lag a finger-stick.':'De su94r. No es un dispositivo médico. La glucosa viene de su sensor FreeStyle Libre y puede ir atrás de una punción en el dedo.',
 'Has diabetes.':'Tiene diabetes.','This card has been turned off.':'Esta tarjeta fue desactivada.','Could not load the card. Try again in a minute.':'No se pudo cargar la tarjeta. Intenta en un minuto.',
 'no reading':'sin lectura'};
function L(s){return LANG==='es'&&ES[s]?ES[s]:s}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function val(mg){if(mg<40)return 'LO';return D.units==='mmol/L'?(mg/18.0182).toFixed(1):String(Math.round(mg))}
var ARROW=['','\\u2193','\\u2198','\\u2192','\\u2197','\\u2191'];
function fast(g,m){return LANG==='es'
 ?'Dale '+g+' g de azúcar rápida: jugo, refresco normal (no de dieta), tabletas de glucosa o caramelos. Revisa otra vez en '+m+' minutos; si sigue baja, dale lo mismo otra vez.'
 :'Give '+g+' g of fast sugar: juice, regular soda (not diet), glucose tablets or candy. Check again in '+m+' minutes; if still low, give the same again.'}
function render(){
  document.documentElement.lang=LANG;document.title=L('Medical information');
  document.getElementById('h').textContent=L('Medical information');
  document.getElementById('lang').textContent=LANG==='es'?'English':'Español';
  var h='<p class="name">'+esc(D.name)+'</p><p class="note">'+esc(D.note||L('Has diabetes.'))+'</p>';
  if(D.glucoseShared){
    var g=D.glucose;
    if(g){
      var old=g.minutes>20, cls=old?'old':g.mg<D.low?'low':g.mg>250?'high':'in';
      h+='<div class="g '+cls+'"><span class="l">'+L('Glucose now')+'</span><span class="v">'+val(g.mg)+' '+(ARROW[g.trend]||'')+'</span><span class="l">'+esc(D.units)+' · '+(g.minutes<1?L('just now'):(LANG==='es'?'hace '+g.minutes+' min':g.minutes+' min ago'))+(cls==='low'?' · <b>'+L('LOW')+'</b>':cls==='high'?' · <b>'+L('HIGH')+'</b>':'')+'</span></div>';
    } else h+='<div class="g old"><span class="l">'+L('Glucose now')+'</span><span class="v">—</span><span class="l">'+L('no reading')+'</span></div>';
  }
  h+='<a class="call sos" href="tel:911">'+L('Call 911')+'</a>';
  h+='<h2>'+L('If they seem low, are awake and can swallow')+'</h2><p>'+fast(D.plan.grams,D.plan.minutes)+'</p>'+(D.plan.text?'<div class="plan"><b>'+L('Their plan:')+'</b> '+esc(D.plan.text)+'</div>':'');
  h+='<h2>'+L('If they are not awake, cannot swallow or have a seizure')+'</h2><ol><li><b>'+L('Call 911.')+'</b></li><li>'+L('Do not put food or drink in their mouth.')+'</li><li>'+L('If there is a glucagon kit or nasal glucagon, use it as its label says.')+'</li><li>'+L('Turn them on their side and stay with them.')+'</li></ol>';
  if(D.contacts.length){h+='<h2>'+L('Whom to call')+'</h2>';D.contacts.forEach(function(c){h+='<a class="call" href="tel:'+esc(c.phone.replace(/[^0-9+]/g,''))+'">'+L('Call')+' '+esc(c.name)+' · '+esc(c.phone)+'</a>'})}
  h+='<p class="muted">'+(D.tells&&!preview?L('Opening this card told their family.')+' ':'')+L('From su94r. Not a medical device. The glucose comes from their FreeStyle Libre sensor and can lag a finger-stick.')+'</p>';
  document.getElementById('m').innerHTML=h;
}
function load(first){
  var hd={Authorization:'Bearer '+token};if(preview||!first)hd['x-su94r-preview']='1';
  fetch('/emergency/data',{cache:'no-store',headers:hd}).then(function(res){return res.json().then(function(j){return{ok:res.ok,j:j}})}).then(function(o){
    if(!o.ok){LANG=LANG||(/^es/i.test(navigator.language||'')?'es':'en');document.getElementById('m').innerHTML='<p class="err">'+L('This card has been turned off.')+'</p>';return}
    D=o.j;LANG=LANG||D.lang||'en';render();
  }).catch(function(){if(!D){LANG=LANG||'en';document.getElementById('m').innerHTML='<p class="err">'+L('Could not load the card. Try again in a minute.')+'</p>'}});
}
document.getElementById('lang').onclick=function(){LANG=LANG==='es'?'en':'es';if(D)render()};
load(true);setInterval(function(){load(false)},60000);
</script>
</body></html>`;
}
