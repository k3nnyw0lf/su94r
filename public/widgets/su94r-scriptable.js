// su94r glucose for Scriptable (free, iPhone and iPad): home screen and lock screen.
//
// 1. In su94r Mini: Settings → Health vault → Watch faces and phone widgets → Make a link.
//    Send that widget link to your iPhone (it starts with https:// and ends in ?token=…).
// 2. In Scriptable: + → paste this whole script → name it "su94r".
// 3. Add a Scriptable widget (home screen, or lock screen: press and hold the lock screen →
//    Customize → Lock Screen → add Scriptable). Press and hold it → Edit Widget →
//    Script: su94r, Parameter: paste your widget link.
// Anyone with the link can see your glucose; remove it any time in su94r Mini.
// iOS decides how often widgets refresh (usually every 5–15 minutes). Not an alarm.

const LINK = (args.widgetParameter || '').trim();
const family = config.widgetFamily || 'small';
const lock = family.startsWith('accessory');

let g = null;
let problem = null;
try {
  if (!/^https:\/\/\S+token=/.test(LINK)) throw new Error('Add your widget link as the Parameter');
  const req = new Request(LINK);
  req.timeoutInterval = 12;
  g = await req.loadJSON();
  if (!g || g.error) throw new Error(g?.error || 'No reading');
} catch (e) {
  problem = String(e.message || e).slice(0, 60);
}

const stale = g && (g.state === 'stale' || g.minutes > 15);
const label = !g ? '' : stale ? 'OLD' : g.state === 'urgent' ? 'URGENT LOW' : g.state === 'low' ? 'LOW' : g.state === 'high' ? 'HIGH' : '';
const age = !g ? '' : g.minutes < 1 ? 'now' : `${g.minutes}m`;

const w = new ListWidget();
w.refreshAfterDate = new Date(Date.now() + 5 * 60e3);

if (lock) {
  // Lock-screen widgets are tinted by iOS, so words carry the warning, not colour.
  if (family === 'accessoryInline') {
    w.addText(problem ? 'su94r: add link' : `${g.value}${g.arrow || ''} ${g.delta || ''} ${label || age}`.trim());
  } else if (family === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const v = w.addText(problem ? '—' : `${g.value}`);
    v.font = Font.boldRoundedSystemFont(g && String(g.value).length > 3 ? 16 : 20);
    v.centerAlignText();
    const a = w.addText(problem ? 'su94r' : `${g.arrow || ''}${label ? ` ${label === 'URGENT LOW' ? 'LOW!' : label}` : ''}`);
    a.font = Font.systemFont(11);
    a.centerAlignText();
  } else {
    const top = w.addText(problem ? 'su94r' : `${g.value} ${g.arrow || ''}${label ? `  ${label}` : ''}`);
    top.font = Font.boldRoundedSystemFont(22);
    const sub = w.addText(problem ? problem : `${g.delta ? `${g.delta} · ` : ''}${g.ago}${g.name ? ` · ${g.name}` : ''}`);
    sub.font = Font.systemFont(12);
  }
} else {
  w.backgroundColor = new Color(label === 'LOW' || label === 'URGENT LOW' ? '#3a1210' : '#0d1117');
  if (problem) {
    const t = w.addText(`su94r\n${problem}`);
    t.textColor = new Color('#ff5d55');
    t.font = Font.systemFont(12);
  } else {
    const head = w.addStack();
    const name = head.addText(g.name || 'Glucose');
    name.font = Font.mediumSystemFont(12);
    name.textColor = new Color('#8b949e');
    head.addSpacer();
    if (label) {
      const l = head.addText(label);
      l.font = Font.boldSystemFont(12);
      l.textColor = new Color(stale ? '#8b949e' : g.color || '#e6edf3');
    }
    w.addSpacer(2);
    const value = w.addText(`${g.value} ${g.arrow || ''}`);
    value.font = Font.boldRoundedSystemFont(family === 'small' ? 40 : 48);
    value.textColor = new Color(stale ? '#8b949e' : g.color || '#3fb950');
    const sub = w.addText(`${g.delta ? `${g.delta} in 15 min · ` : ''}${g.ago}`);
    sub.font = Font.systemFont(12);
    sub.textColor = new Color('#c9d1d9');
  }
}

if (config.runsInWidget) Script.setWidget(w);
else if (lock) await w.presentAccessoryRectangular();
else await w.presentSmall();
Script.complete();
