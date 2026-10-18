// Pages for su94r's public Alexa skill (workers/sugar.js): the account-linking sign-in with its
// consents, the delete-my-data page, and short result pages. English and Spanish. No scripts:
// plain HTML forms, so the page works in Alexa's in-app browser and passes a strict CSP.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
  :root { color-scheme: light dark; --bg:#0d1117; --card:#161b22; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#3fb950; --warn:#e3a33b; --bad:#ff5d55; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fa; --card:#fff; --line:#d0d7de; --text:#1f2328; --muted:#57606a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:560px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:1.5rem; margin:.2em 0 .4em; } h2 { font-size:1.05rem; margin:1.2em 0 .4em; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:12px 0; }
  ol { padding-left:1.2em; margin:.3em 0; } li { margin:.3em 0; }
  label.f { display:block; font-weight:600; margin:.8em 0 .2em; }
  input[type=email], input[type=password] { width:100%; padding:12px; font-size:16px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--text); }
  .c { display:flex; gap:10px; align-items:flex-start; margin:.7em 0; font-size:.95rem; }
  .c input { width:22px; height:22px; margin-top:2px; flex:none; }
  button { width:100%; padding:14px; margin-top:14px; font-size:17px; font-weight:700; border:0; border-radius:10px; background:var(--accent); color:#04130a; }
  button.danger { background:var(--bad); color:#fff; }
  .err { border-color:var(--bad); color:var(--bad); font-weight:600; }
  .muted { color:var(--muted); font-size:.9rem; } a { color:inherit; }
  .lang { float:right; font-size:.9rem; }`;

const shell = (lang, title, body) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

const TXT = {
  en: {
    title: 'Link su94r to Alexa',
    intro: 'su94r reads Libre glucose for you and your family and says it on Alexa and Echo Show screens. You sign in with a <b>follower account made only for su94r</b>, never your own Libre login.',
    before: 'Before you sign in (5 minutes)',
    steps: [
      'Install <b>LibreLinkUp</b> and create a new account with an email you do not use for Libre (for example yourname+su94r@gmail.com). This is your su94r follower.',
      'On the Libre user\'s phone, open <b>FreeStyle Libre</b> → Menu → <b>Connected Apps</b> → <b>LibreLinkUp</b> → add that email. Family members who want to share do the same.',
      'Open LibreLinkUp with the follower account and accept the invitations.',
      'Sign in below with the <b>follower</b> email and password.',
    ],
    why: 'Why a separate follower? Only the people who shared with it can ever be seen, and if Abbott ever blocks su94r, your own Libre account, readings and alarms keep working.',
    email: 'Follower email', password: 'Follower password',
    consents: {
      adult_terms: 'I am 18 or older and I agree to the <a href="/sugar/terms" target="_blank" rel="noopener">Terms of Use</a> and the <a href="/sugar/privacy" target="_blank" rel="noopener">Privacy Policy</a>.',
      health_collect: 'I consent to su94r collecting and processing the glucose readings of the people who share with this follower account, as described in the <a href="/sugar/health-data" target="_blank" rel="noopener">Consumer Health Data Privacy Policy</a>. For each of them I am the person who wears the sensor, their parent or legal guardian, or I have their permission.',
      share_amazon: 'Separately, I consent to su94r sending these readings to Amazon so Alexa can say and show them on my devices.',
      not_medical: 'I understand su94r is <b>not a medical device and not an alarm</b>, and it can be late, wrong or stop without warning. Dosing decisions should not be made based on this device. The user should follow instructions on the continuous glucose monitoring system. This device is not intended to replace self-monitoring practices as advised by a physician. I will keep my Libre alarms on and call 911 in an emergency.',
      unofficial: 'I understand su94r reads LibreLinkUp without Abbott\'s approval or support, and Abbott may stop it at any time.',
    },
    submit: 'Agree and link',
    errors: {
      consent: 'Please tick every box. Each one is needed to link su94r.',
      missing: 'Enter the follower email and password.',
      credentials: 'Libre did not accept that email and password. Use the follower account, and accept Libre\'s latest terms in the LibreLinkUp app if it asks.',
      libre: 'Libre did not answer just now. Try again in a minute.',
      nobody: 'No one shares with this follower account yet. Share with it from the FreeStyle Libre app, accept in LibreLinkUp, then try again.',
    },
    footer: 'Free and open source. <a href="/sugar/delete">Delete my su94r data</a> · <a href="/sugar/terms">Terms</a> · <a href="/sugar/privacy">Privacy</a>',
    delTitle: 'Delete my su94r data',
    delIntro: 'This deletes your su94r account, the sealed follower login, sign-in tokens and tile settings at once. Turning su94r off in the Alexa app does the same. It does not change your Libre or LibreLinkUp accounts.',
    delSubmit: 'Delete everything',
    delErrors: { notfound: 'No su94r account uses that follower email.', credentials: 'That password does not match the follower account.' },
    done: { deleted: 'Done. Your su94r data is deleted.', bad: 'This link is not valid. Start again from the Alexa app: su94r → Link account.' },
  },
  es: {
    title: 'Vincular su94r con Alexa',
    intro: 'su94r lee la glucosa de Libre tuya y de tu familia y la dice en Alexa y en las pantallas Echo Show. Inicias sesión con una <b>cuenta seguidora creada solo para su94r</b>, nunca con tu propio inicio de sesión de Libre.',
    before: 'Antes de iniciar sesión (5 minutos)',
    steps: [
      'Instala <b>LibreLinkUp</b> y crea una cuenta nueva con un correo que no uses para Libre (por ejemplo tunombre+su94r@gmail.com). Esta es tu seguidora de su94r.',
      'En el teléfono de quien usa el Libre, abre <b>FreeStyle Libre</b> → Menú → <b>Aplicaciones conectadas</b> → <b>LibreLinkUp</b> → agrega ese correo. Los familiares que quieran compartir hacen lo mismo.',
      'Abre LibreLinkUp con la cuenta seguidora y acepta las invitaciones.',
      'Inicia sesión abajo con el correo y la contraseña de la <b>seguidora</b>.',
    ],
    why: '¿Por qué una seguidora aparte? Solo se puede ver a quienes compartieron con ella, y si Abbott bloquea su94r algún día, tu propia cuenta de Libre, tus lecturas y tus alarmas siguen funcionando.',
    email: 'Correo de la seguidora', password: 'Contraseña de la seguidora',
    consents: {
      adult_terms: 'Tengo 18 años o más y acepto los <a href="/sugar/terms?lang=es" target="_blank" rel="noopener">Términos de uso</a> y la <a href="/sugar/privacy?lang=es" target="_blank" rel="noopener">Política de privacidad</a>.',
      health_collect: 'Doy mi consentimiento para que su94r recoja y procese las lecturas de glucosa de quienes comparten con esta cuenta seguidora, como se explica en la <a href="/sugar/health-data?lang=es" target="_blank" rel="noopener">Política de privacidad de datos de salud</a>. Para cada una de esas personas, soy quien usa el sensor, su madre, padre o tutor legal, o tengo su permiso.',
      share_amazon: 'Por separado, doy mi consentimiento para que su94r envíe estas lecturas a Amazon para que Alexa las diga y las muestre en mis dispositivos.',
      not_medical: 'Entiendo que su94r <b>no es un dispositivo médico ni una alarma</b>, y que puede llegar tarde, equivocarse o dejar de funcionar sin aviso. No se deben tomar decisiones de dosis basadas en este dispositivo. El usuario debe seguir las instrucciones del sistema de monitoreo continuo de glucosa. Este dispositivo no sustituye las prácticas de automonitoreo indicadas por un médico. Mantendré encendidas las alarmas de Libre y llamaré al 911 en una emergencia.',
      unofficial: 'Entiendo que su94r lee LibreLinkUp sin la aprobación ni el apoyo de Abbott, y que Abbott puede detenerlo en cualquier momento.',
    },
    submit: 'Aceptar y vincular',
    errors: {
      consent: 'Marca todas las casillas. Cada una es necesaria para vincular su94r.',
      missing: 'Escribe el correo y la contraseña de la seguidora.',
      credentials: 'Libre no aceptó ese correo y contraseña. Usa la cuenta seguidora y, si te lo pide, acepta los términos nuevos de Libre en la app LibreLinkUp.',
      libre: 'Libre no respondió ahora. Inténtalo de nuevo en un minuto.',
      nobody: 'Nadie comparte con esta cuenta seguidora todavía. Comparte con ella desde la app FreeStyle Libre, acepta en LibreLinkUp y vuelve a intentarlo.',
    },
    footer: 'Gratis y de código abierto. <a href="/sugar/delete?lang=es">Borrar mis datos de su94r</a> · <a href="/sugar/terms?lang=es">Términos</a> · <a href="/sugar/privacy?lang=es">Privacidad</a>',
    delTitle: 'Borrar mis datos de su94r',
    delIntro: 'Esto borra al instante tu cuenta de su94r, el inicio de sesión sellado de la seguidora, los tokens y la configuración del widget. Desactivar su94r en la app de Alexa hace lo mismo. No cambia tus cuentas de Libre ni de LibreLinkUp.',
    delSubmit: 'Borrar todo',
    delErrors: { notfound: 'Ninguna cuenta de su94r usa ese correo de seguidora.', credentials: 'Esa contraseña no coincide con la cuenta seguidora.' },
    done: { deleted: 'Listo. Tus datos de su94r están borrados.', bad: 'Este enlace no es válido. Empieza otra vez desde la app de Alexa: su94r → Vincular cuenta.' },
  },
};

const other = (lang) => (lang === 'es' ? '<a href="?lang=en">English</a>' : '<a href="?lang=es">Español</a>');

export function linkPage({ lang = 'en', params, error = null, email = '' }) {
  const t = TXT[lang] || TXT.en;
  const hidden = ['client_id', 'redirect_uri', 'state', 'response_type'].map((k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('');
  const langLink = `<a href="?${new URLSearchParams({ ...params, lang: lang === 'es' ? 'en' : 'es' })}">${lang === 'es' ? 'English' : 'Español'}</a>`;
  return shell(lang, t.title, `
    <span class="lang">${langLink}</span>
    <h1>${t.title}</h1>
    <p>${t.intro}</p>
    ${error ? `<div class="card err" role="alert">${esc(t.errors[error] || error)}</div>` : ''}
    <div class="card"><h2>${t.before}</h2><ol>${t.steps.map((s) => `<li>${s}</li>`).join('')}</ol><p class="muted">${t.why}</p></div>
    <form method="post" action="/sugar/link" class="card" autocomplete="on">
      ${hidden}<input type="hidden" name="lang" value="${lang}">
      <label class="f" for="email">${t.email}</label><input id="email" name="email" type="email" required autocomplete="username" value="${esc(email)}">
      <label class="f" for="password">${t.password}</label><input id="password" name="password" type="password" required autocomplete="current-password">
      ${Object.entries(t.consents).map(([k, v]) => `<label class="c"><input type="checkbox" name="${k}" value="yes" required><span>${v}</span></label>`).join('')}
      <button type="submit">${t.submit}</button>
    </form>
    <p class="muted">${t.footer}</p>`);
}

export function deletePage(lang = 'en', error = null) {
  const t = TXT[lang] || TXT.en;
  return shell(lang, t.delTitle, `
    <span class="lang">${other(lang)}</span>
    <h1>${t.delTitle}</h1><p>${t.delIntro}</p>
    ${error ? `<div class="card err" role="alert">${esc(t.delErrors[error] || error)}</div>` : ''}
    <form method="post" action="/sugar/delete" class="card">
      <input type="hidden" name="lang" value="${lang}">
      <label class="f" for="email">${t.email}</label><input id="email" name="email" type="email" required autocomplete="username">
      <label class="f" for="password">${t.password}</label><input id="password" name="password" type="password" required autocomplete="current-password">
      <button type="submit" class="danger">${t.delSubmit}</button>
    </form>`);
}

/** A legal page from sugar-legal.js ({ title, body }) in the same frame. */
export function docPage(lang, { title, body }) {
  return shell(lang, title, body);
}

export function donePage(lang = 'en', what = 'deleted') {
  const t = TXT[lang] || TXT.en;
  return shell(lang, 'su94r', `<h1>su94r</h1><div class="card">${esc(t.done[what] || what)}</div>`);
}

// ─── served by the Cloudflare proxy ─────────────────────────────────────────────────────────

export const SUGAR_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://pitangui.amazon.com https://layla.amazon.com https://alexa.amazon.co.jp; base-uri 'none'; frame-ancestors 'none'",
};
const AMAZON_LINK_BACK = /^https:\/\/(pitangui\.amazon\.com|layla\.amazon\.com|alexa\.amazon\.co\.jp)\/api\/skill\/link\/[A-Z0-9]+\?/;

/** Turns an envelope from su94r-cgm (x-su94r-page: 1) into the real page, or the redirect back to Amazon. */
export async function servePage(res) {
  const j = await res.json().catch(() => ({}));
  if (j.location) {
    if (!AMAZON_LINK_BACK.test(j.location)) return new Response('bad redirect', { status: 502 });
    return new Response(null, { status: 302, headers: { Location: j.location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  return new Response(String(j.page || ''), { status: res.status, headers: SUGAR_PAGE_HEADERS });
}
