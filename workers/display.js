// Big-screen glucose page: Samsung/LG TV browsers, a Samsung Family Hub fridge, Echo Show
// (Silk), Fire TV, tablets, phones, a spare monitor on the wall. One person fills the
// screen; several become tiles, most urgent first; a widget-sized screen gets a compact
// tile. Self-contained: no external scripts, fonts or trackers.
//
// Two ways in:
//   /d/<key>  the display key in the link (anyone with the link can see it)
//   /tv       pairing: the screen shows a short code, su94r Mini enters it, and the screen
//             keeps its own revocable token (in its own browser storage).
// Plain ES2017 on purpose: TV and fridge browsers can be old.

export function displayPage(key, { pair = false } = {}) {
  const k = JSON.stringify(String(key || '')).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Glucose</title>
<style>
:root{--bg:#05080d;--fg:#f2f5f8;--muted:#8b949e;--in:#3fb950;--high:#e3a33b;--low:#ff5d55;--stale:#6e7681;--band:rgba(63,185,80,.14);--grid:rgba(255,255,255,.08)}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;cursor:none}
#app{height:100%;display:flex;flex-direction:column;padding:2.5vh 3vw}
.top{display:flex;justify-content:space-between;align-items:baseline;color:var(--muted);font-size:max(16px,2.6vh)}
.clock{font-variant-numeric:tabular-nums;color:var(--fg)}
.one{flex:1;display:flex;flex-direction:column;min-height:0}
.read{display:flex;align-items:center;justify-content:center;gap:2vw;flex:0 0 auto;margin-top:2vh}
.val{font-size:min(30vh,24vw);font-weight:750;line-height:.95;font-variant-numeric:tabular-nums;color:var(--c)}
.arrow{width:min(16vh,12vw);height:min(16vh,12vw);fill:none;stroke:var(--c);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;transition:transform .4s}
.side{display:flex;flex-direction:column;gap:1vh;font-size:max(16px,3.4vh);color:var(--muted)}
.side .d{color:var(--fg);font-weight:650;font-size:max(18px,4.6vh)}
.warn{color:var(--high)!important;font-weight:650}
.graph{flex:1;min-height:0;margin-top:2vh}
.graph svg{width:100%;height:100%;display:block}
.tiles{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,34vw),1fr));gap:2vh 2vw;align-content:center;margin-top:2vh}
.tile{border-left:1vh solid var(--c);background:rgba(255,255,255,.04);border-radius:1.4vh;padding:2vh 2vw;display:flex;flex-direction:column;gap:1vh}
.tile .n{font-size:max(16px,3.2vh);font-weight:650}
.tile .r{display:flex;align-items:center;gap:1.2vw}
.tile .val{font-size:min(14vh,9vw)}
.tile .arrow{width:min(8vh,5vw);height:min(8vh,5vw)}
.tile .m{color:var(--muted);font-size:max(14px,2.4vh)}
[data-c=in]{--c:var(--in)}[data-c=high]{--c:var(--high)}[data-c=low],[data-c=urgent]{--c:var(--low)}[data-c=stale],[data-c=none]{--c:var(--stale)}
[data-c=stale] .val{text-decoration:line-through;text-decoration-thickness:.6vh}
[data-c=urgent]{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{background:rgba(255,93,85,.16)}}
@media (prefers-reduced-motion:reduce){[data-c=urgent]{animation:none}}
.foot{color:var(--muted);font-size:max(12px,1.6vh);display:flex;justify-content:space-between;margin-top:1.5vh}
.err{color:var(--high)}
text{fill:var(--muted);font-size:max(12px,1.8vh)}
.pair{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:3vh}
.code{font:700 min(18vh,14vw)/1 ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:.08em;color:var(--fg)}
.how{color:var(--muted);font-size:max(16px,3vh);max-width:80vw;line-height:1.35}
.how b{color:var(--fg)}
/* Widget-sized screens (a corner of a fridge, a small tablet tile): compact. */
.small #app{padding:8px 10px}
.small .top{font-size:13px}
.small .foot{display:none}
.small .val{font-size:min(34vh,26vw)}
.small .side{font-size:13px;gap:2px}
.small .side .d{font-size:15px}
.small .graph{margin-top:6px}
.small .code{font-size:min(16vh,13vw)}
.small .how{font-size:13px}
/* A phone shared from su94r Mini (QR code): its options. */
.optsBtn{position:fixed;right:12px;bottom:12px;z-index:5;background:rgba(255,255,255,.1);color:var(--fg);border:1px solid rgba(255,255,255,.2);border-radius:20px;padding:8px 14px;font-size:14px;cursor:pointer}
.opts{position:fixed;top:0;left:0;right:0;bottom:0;z-index:10;background:rgba(0,0,0,.86);overflow:auto;cursor:auto;display:flex;justify-content:center;align-items:flex-start;padding:16px}
.opts .box{max-width:560px;width:100%;background:#0d1117;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:18px;font-size:16px;line-height:1.45}
.opts h2{margin:0 0 8px;font-size:22px}.opts h3{margin:16px 0 4px;font-size:17px}.opts p{margin:6px 0}
.opts a{color:#58a6ff}.opts .btn{display:inline-block;background:#238636;color:#fff;border:0;border-radius:8px;padding:9px 14px;font-size:15px;text-decoration:none;cursor:pointer;margin:2px 0}
.opts .btn.ghost{background:transparent;border:1px solid rgba(255,255,255,.3);color:var(--fg)}
.opts code{word-break:break-all;font-size:12px}.opts .s{font-size:13px;color:var(--muted)}
.opts button[data-copy]{font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:transparent;color:var(--fg);cursor:pointer}
</style>
</head>
<body>
<div id="app"><div class="top"><span id="title">Glucose</span><span class="clock" id="clock"></span></div><div id="main" class="one"></div>
<div class="foot"><span id="status"></span><span>Not a medical device · readings can be late</span></div></div>
<script>
const KEY=${k};
const PAIR=${pair ? 'true' : 'false'};
const STALE=10*60e3, MMOL=18.0182, ROT={1:90,2:45,3:0,4:-45,5:-90};
let data=null, lastOk=0;
const $=(id)=>document.getElementById(id);
const fmt=(mg,u)=>u==='mmol/L'?(mg/MMOL).toFixed(1):String(Math.round(mg));
const cat=(p)=>{const l=p.latest;if(!l)return'none';if(Date.now()-l.t>STALE)return'stale';if(l.mg<55)return'urgent';if(l.mg<p.low)return'low';if(l.mg>p.high)return'high';return'in'};
const ago=(t)=>{const m=Math.round((Date.now()-t)/60e3);return m<=0?'just now':m<60?m+' min ago':Math.floor(m/60)+' h '+(m%60)+' min ago'};
function delta(p){const l=p.latest;if(!l)return'';const ref=p.history.find(([t])=>Math.abs(t-(l.t-15*60e3))<=4*60e3);if(!ref)return'';const d=l.mg-ref[1];const v=p.units==='mmol/L'?Math.abs(d/MMOL).toFixed(1):Math.abs(Math.round(d));return(d<0?'\\u2212':'+')+v+' in 15 min'}
function arrow(t){if(ROT[t]==null)return'';return '<svg class="arrow" viewBox="0 0 24 24" style="transform:rotate('+ROT[t]+'deg)"><path d="M4 12h14M12.5 6l6 6-6 6"/></svg>'}
function esc(s){return String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function graph(p,hours){
  const el=$('graph');if(!el)return;const W=el.clientWidth,H=el.clientHeight;if(!W||!H)return;
  const to=Date.now(),from=to-hours*3600e3;const pts=p.history.filter(([t])=>t>=from);
  const vals=pts.map((q)=>q[1]);const lo=Math.min(50,...vals)-10,hi=Math.max(p.high+40,250,...vals)+10;
  const x=(t)=>40+(t-from)/(to-from)*(W-90),y=(v)=>10+(1-(v-lo)/(hi-lo))*(H-40);
  let s='<svg viewBox="0 0 '+W+' '+H+'"><rect x="40" y="'+y(p.high)+'" width="'+(W-90)+'" height="'+(y(p.low)-y(p.high))+'" fill="var(--band)"/>';
  for(const v of [p.low,p.high])s+='<text x="'+(W-44)+'" y="'+(y(v)+5)+'">'+fmt(v,p.units)+'</text>';
  for(let t=Math.ceil(from/3600e3)*3600e3;t<to;t+=3600e3){const d=new Date(t);s+='<line x1="'+x(t)+'" x2="'+x(t)+'" y1="10" y2="'+(H-30)+'" stroke="var(--grid)"/><text x="'+x(t)+'" y="'+(H-6)+'" text-anchor="middle">'+((d.getHours()%12)||12)+(d.getHours()<12?'a':'p')+'</text>'}
  let d='',prev=null;for(const [t,v] of pts){d+=(!prev||t-prev>20*60e3?'M':'L')+x(t).toFixed(1)+','+y(v).toFixed(1);prev=t}
  const c=getComputedStyle(document.querySelector('[data-c]')||document.body).getPropertyValue('--c')||'#3fb950';
  s+='<path d="'+d+'" fill="none" stroke="'+c+'" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>';
  if(p.latest)s+='<circle cx="'+x(p.latest.t)+'" cy="'+y(p.latest.mg)+'" r="8" fill="'+c+'"/>';
  el.innerHTML=s+'</svg>';
}
function render(){
  document.documentElement.classList.toggle('small',small());
  if(pairing)return;
  const now=new Date();$('clock').textContent=now.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  const main=$('main');
  if(!data){main.innerHTML='<div class="read"><div class="side">Loading\\u2026</div></div>';return}
  const people=[...data.people].sort((a,b)=>({urgent:0,low:1,stale:2,high:3,none:4,in:5}[cat(a)]-{urgent:0,low:1,stale:2,high:3,none:4,in:5}[cat(b)]));
  if(!people.length){main.innerHTML='<div class="read"><div class="side">No one is sharing with this account yet.</div></div>';return}
  if(people.length===1){
    const p=people[0],c=cat(p),l=p.latest;$('title').textContent=p.name;
    main.className='one';main.dataset.c=c;
    main.innerHTML='<div class="read"><span class="val">'+(l?(l.mg<40?'LO':l.mg>400?'HI':fmt(l.mg,p.units)):'\\u2014')+'</span>'+(l&&c!=='stale'?arrow(l.trend):'')+
      '<div class="side"><span>'+esc(p.units)+'</span><span class="d">'+(c==='stale'?'':delta(p))+'</span><span class="'+(c==='stale'?'warn':'')+'">'+(l?(c==='stale'?'No reading for '+ago(l.t).replace(' ago',''):ago(l.t)):'')+'</span></div></div><div class="graph" id="graph"></div>';
    graph(p,3);document.title=(l?fmt(l.mg,p.units)+' \\u00b7 ':'')+p.name;
  }else{
    $('title').textContent=people.length+' people';main.className='tiles';delete main.dataset.c;
    main.innerHTML=people.map((p)=>{const c=cat(p),l=p.latest;return '<div class="tile" data-c="'+c+'"><span class="n">'+esc(p.name)+'</span><div class="r"><span class="val">'+(l?(l.mg<40?'LO':l.mg>400?'HI':fmt(l.mg,p.units)):'\\u2014')+'</span>'+(l&&c!=='stale'?arrow(l.trend):'')+'</div><span class="m">'+(l?(c==='stale'?'<span class="warn">no reading for '+ago(l.t).replace(' ago','')+'</span>':delta(p)+' \\u00b7 '+ago(l.t)):'waiting')+'</span></div>'}).join('');
    document.title='Glucose \\u00b7 '+people.length+' people';
  }
  const late=Date.now()-lastOk>3*60e3;$('status').className=late?'err':'';$('status').textContent=late?'Can\\u2019t reach the server \\u2014 retrying':'Updated '+ago(data.at);
}
// ---- pairing (/tv): the screen's own token lives in its browser storage ----
const mem={};
const store={get:(k)=>{try{return localStorage.getItem(k)}catch(e){return mem[k]||null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){mem[k]=v}},del:(k)=>{try{localStorage.removeItem(k)}catch(e){delete mem[k]}}};
const small=()=>Math.min(innerWidth,innerHeight)<420;
let pairing=false;
function showCode(code){
  $('title').textContent='Show your glucose here';$('status').textContent='';
  const main=$('main');main.className='pair';delete main.dataset.c;
  main.innerHTML='<div class="code">'+esc(code||'\u2026')+'</div><div class="how">On your computer open <b>su94r Mini \u2192 Settings \u2192 Alexa and screens \u2192 Screens and widgets</b>, type this code and give this screen a name. The code changes every 15 minutes.</div>';
}
async function pairStep(){
  pairing=true;
  try{
    let secret=store.get('su94rScreenSecret'),code=store.get('su94rScreenCode');
    if(!secret){
      const r=await fetch('/pair/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:small()?'widget':'screen'})});
      const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);
      secret=j.secret;code=j.code;store.set('su94rScreenSecret',secret);store.set('su94rScreenCode',code);
    }
    showCode(code);
    const r=await fetch('/pair/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:secret})});
    const j=await r.json().catch(()=>({}));
    if(j.status==='paired'&&j.token){store.set('su94rScreenToken',j.token);store.del('su94rScreenSecret');store.del('su94rScreenCode');pairing=false;return load()}
    if(j.status==='expired'||j.status==='unknown'||(j.status==='paired'&&!j.token)){store.del('su94rScreenSecret');store.del('su94rScreenCode')}
  }catch(e){$('status').textContent='Problem: '+e.message}
  setTimeout(pairStep,3000);
}
async function load(){
  if(pairing)return;
  try{
    let r;
    if(PAIR){
      const token=store.get('su94rScreenToken');
      if(!token)return pairStep();
      r=await fetch('/screen/data',{cache:'no-store',headers:{Authorization:'Bearer '+token}});
      if(r.status===401){store.del('su94rScreenToken');data=null;return pairStep()}
    }else{
      r=await fetch('/display/data?key='+encodeURIComponent(KEY),{cache:'no-store'});
    }
    const j=await r.json().catch(()=>({}));
    if(r.status===401)throw new Error('this display link has the wrong key');if(r.status===503)throw new Error('the display is not set up yet ('+(j.error||'server')+')');if(!r.ok)throw new Error(j.error||r.status);data=j;lastOk=Date.now()}
  catch(e){$('status').textContent='Problem: '+e.message}
  render();
}
// ---- shared from su94r Mini: its QR code opens /tv#join=<invite>, which links this phone once ----
// Returns false when a share link was opened and could not be used (the page then says why
// instead of falling back to the TV pairing code).
async function join(){
  const m=/[#&]join=([0-9a-f]{64})/.exec(location.hash||'');if(!m)return true;
  try{history.replaceState(null,'',location.pathname)}catch(e){}
  $('title').textContent='Linking this phone…';
  try{
    const r=await fetch('/share/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invite:m[1]})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok)throw new Error(j.error||('error '+r.status));
    store.set('su94rScreenToken',j.token);store.set('su94rShared',j.role||'me');if(j.nsToken)store.set('su94rNsToken',j.nsToken);
    store.del('su94rScreenSecret');store.del('su94rScreenCode');
    setTimeout(()=>openOpts(true),1200);
    return true;
  }catch(e){
    if(store.get('su94rScreenToken'))return true;   // already linked before: just show the glucose
    pairing=true;$('title').textContent='Could not link this phone';$('status').textContent='';
    const main=$('main');main.className='pair';delete main.dataset.c;
    main.innerHTML='<div class="how">'+esc(e.message)+'</div><div class="how">On the computer: su94r Mini → Health vault → <b>Share to another phone</b> makes a new code.</div>';
    return false;
  }
}
function optsButton(){
  if(!PAIR||!store.get('su94rShared')||!store.get('su94rScreenToken')||$('optsBtn'))return;
  const b=document.createElement('button');b.id='optsBtn';b.className='optsBtn';b.textContent='⚙ Phone options';b.onclick=()=>openOpts(false);document.body.appendChild(b);
}
async function openOpts(first){
  if($('opts'))return;
  let x={};
  try{const r=await fetch('/share/extras',{cache:'no-store',headers:{Authorization:'Bearer '+store.get('su94rScreenToken')}});x=await r.json().catch(()=>({}))}catch(e){}
  const ns=store.get('su94rNsToken'),base=location.origin,a=x.alerts;
  const copy=(v)=>' <button data-copy="'+esc(v)+'">Copy</button>';
  const el=document.createElement('div');el.className='opts';el.id='opts';
  el.innerHTML='<div class="box"><h2>'+(first?'This phone is linked':'Phone options')+'</h2>'+
    '<p>It shows the glucose live, even with every computer off. Keep it one tap away: Android Chrome ⋮ → <b>Add to Home screen</b>; iPhone Safari Share → <b>Add to Home Screen</b>.</p>'+
    (a?'<h3>Low alerts on this phone</h3><p>'+(a.role==='family'?'You are told when a low is not handled.'+(a.on?'':' The owner has not switched family alerts on yet.'):'The same alerts as the owner: every low, repeated until “I’m OK”.')+
      ' Install <b>ntfy</b> (free): <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy">Play Store</a> · <a href="https://apps.apple.com/app/ntfy/id1625396347">App Store</a>, then:</p>'+
      '<p><a class="btn" href="ntfy://'+esc(a.url.replace('https://','').replace('http://',''))+'">Subscribe in ntfy</a> <a class="btn ghost" href="'+esc(a.url)+'">Open in the browser</a></p>'+
      '<p class="s">Or in ntfy tap + and paste the topic: <code>'+esc(a.topic)+'</code>'+copy(a.topic)+'</p>':'')+
    (x.telegram?'<h3>Alerts on Telegram</h3><p>Prefer Telegram? Tap below, then press <b>Start</b> in Telegram. The link works once, for 15 minutes.</p><p><a class="btn" href="'+esc(x.telegram)+'">Open in Telegram</a></p>':'')+
    (ns?'<h3>Watch and widgets</h3><p>In <b>GlucoDataHandler</b> (free, also on the Pixel Watch): Sources → Nightscout, then this address and token.</p>'+
      '<p class="s"><code>'+esc(base)+'/ns</code>'+copy(base+'/ns')+'</p><p class="s"><code>'+esc(ns)+'</code>'+copy(ns)+'</p>':'')+
    '<p><button id="optsClose" class="btn">Done</button> <button id="unlink" class="btn ghost">Unlink this phone</button></p></div>';
  document.body.appendChild(el);
  el.addEventListener('click',(e)=>{const v=e.target.getAttribute&&e.target.getAttribute('data-copy');if(v&&navigator.clipboard){navigator.clipboard.writeText(v).then(()=>{e.target.textContent='Copied'}).catch(()=>{})}});
  $('optsClose').onclick=()=>el.remove();
  $('unlink').onclick=()=>{if(confirm('Unlink this phone? It stops showing the glucose here.')){store.del('su94rScreenToken');store.del('su94rShared');store.del('su94rNsToken');location.reload()}};
}
join().then((ok)=>{if(ok)load()});setInterval(load,60e3);setInterval(render,15e3);setInterval(optsButton,2000);addEventListener('resize',render);
setTimeout(()=>location.reload(),6*3600e3);
if('wakeLock' in navigator){const lock=()=>navigator.wakeLock.request('screen').catch(()=>{});lock();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')lock()})}
</script>
</body>
</html>`;
}
