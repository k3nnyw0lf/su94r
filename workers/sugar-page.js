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
  input[type=email], input[type=password], input[type=text], input[type=number], input:not([type]), select { width:100%; padding:12px; font-size:16px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--text); }
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
    intro: 'su94r reads FreeStyle Libre or Dexcom glucose for you and your family and says it on Alexa and Echo Show screens. Your account is private: it shows only the people who share with it.',
    before: 'Before you sign in (5 minutes)',
    steps: [
      'Install <b>LibreLinkUp</b> and create a new account with an email you do not use for Libre (for example yourname+su94r@gmail.com). This is your su94r follower.',
      'On the Libre user\'s phone, open <b>FreeStyle Libre</b> → Menu → <b>Connected Apps</b> → <b>LibreLinkUp</b> → add that email. Family members who want to share do the same.',
      'Open LibreLinkUp with the follower account and accept the invitations.',
      'Sign in below with the <b>follower</b> email and password.',
    ],
    why: 'Why a separate follower? Only the people who shared with it can ever be seen, and if Abbott ever blocks su94r, your own Libre account, readings and alarms keep working.',
    email: 'Email or username (Libre follower or Dexcom)', password: 'Password',
    consents: {
      adult_terms: 'I am 18 or older and I agree to the <a href="/sugar/terms" target="_blank" rel="noopener">Terms of Use</a> and the <a href="/sugar/privacy" target="_blank" rel="noopener">Privacy Policy</a>.',
      health_collect: 'I consent to su94r collecting and processing the glucose readings of the people this account follows (the people who share with this Libre follower, or the Dexcom wearer), as described in the <a href="/sugar/health-data" target="_blank" rel="noopener">Consumer Health Data Privacy Policy</a>. For each of them I am the person who wears the sensor, their parent or legal guardian, or I have their permission.',
      share_amazon: 'Separately, I consent to su94r sending these readings to Amazon so Alexa can say and show them on my devices.',
      not_medical: 'I understand su94r is <b>not a medical device and not an alarm</b>, and it can be late, wrong or stop without warning. Dosing decisions should not be made based on this device. The user should follow instructions on the continuous glucose monitoring system. This device is not intended to replace self-monitoring practices as advised by a physician. I will keep my Libre or Dexcom alarms (and Dexcom Follow) on and call 911 in an emergency.',
      unofficial: 'I understand su94r reads LibreLinkUp or Dexcom Share without the approval or support of Abbott or Dexcom, and either may stop it at any time.',
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
    delErrors: { notfound: 'No su94r account uses that email or username.', credentials: 'That password does not match the account.' },
    done: { deleted: 'Done. Your su94r data is deleted.', bad: 'This link is not valid. Start again from the Alexa app: su94r → Link account.' },
  },
  es: {
    title: 'Vincular su94r con Alexa',
    intro: 'su94r lee la glucosa de FreeStyle Libre o Dexcom tuya y de tu familia y la dice en Alexa y en las pantallas Echo Show. Tu cuenta es privada: muestra solo a quienes comparten con ella.',
    before: 'Antes de iniciar sesión (5 minutos)',
    steps: [
      'Instala <b>LibreLinkUp</b> y crea una cuenta nueva con un correo que no uses para Libre (por ejemplo tunombre+su94r@gmail.com). Esta es tu seguidora de su94r.',
      'En el teléfono de quien usa el Libre, abre <b>FreeStyle Libre</b> → Menú → <b>Aplicaciones conectadas</b> → <b>LibreLinkUp</b> → agrega ese correo. Los familiares que quieran compartir hacen lo mismo.',
      'Abre LibreLinkUp con la cuenta seguidora y acepta las invitaciones.',
      'Inicia sesión abajo con el correo y la contraseña de la <b>seguidora</b>.',
    ],
    why: '¿Por qué una seguidora aparte? Solo se puede ver a quienes compartieron con ella, y si Abbott bloquea su94r algún día, tu propia cuenta de Libre, tus lecturas y tus alarmas siguen funcionando.',
    email: 'Correo o usuario (seguidora de Libre o Dexcom)', password: 'Contraseña',
    consents: {
      adult_terms: 'Tengo 18 años o más y acepto los <a href="/sugar/terms?lang=es" target="_blank" rel="noopener">Términos de uso</a> y la <a href="/sugar/privacy?lang=es" target="_blank" rel="noopener">Política de privacidad</a>.',
      health_collect: 'Doy mi consentimiento para que su94r recoja y procese las lecturas de glucosa de las personas que sigue esta cuenta (quienes comparten con esta seguidora de Libre, o quien usa el Dexcom), como se explica en la <a href="/sugar/health-data?lang=es" target="_blank" rel="noopener">Política de privacidad de datos de salud</a>. Para cada una de esas personas, soy quien usa el sensor, su madre, padre o tutor legal, o tengo su permiso.',
      share_amazon: 'Por separado, doy mi consentimiento para que su94r envíe estas lecturas a Amazon para que Alexa las diga y las muestre en mis dispositivos.',
      not_medical: 'Entiendo que su94r <b>no es un dispositivo médico ni una alarma</b>, y que puede llegar tarde, equivocarse o dejar de funcionar sin aviso. No se deben tomar decisiones de dosis basadas en este dispositivo. El usuario debe seguir las instrucciones del sistema de monitoreo continuo de glucosa. Este dispositivo no sustituye las prácticas de automonitoreo indicadas por un médico. Mantendré encendidas las alarmas de Libre o Dexcom (y Dexcom Follow) y llamaré al 911 en una emergencia.',
      unofficial: 'Entiendo que su94r lee LibreLinkUp o Dexcom Share sin la aprobación ni el apoyo de Abbott ni de Dexcom, y que cualquiera de ellos puede detenerlo en cualquier momento.',
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
    delErrors: { notfound: 'Ninguna cuenta de su94r usa ese correo o usuario.', credentials: 'Esa contraseña no coincide con la cuenta seguidora.' },
    done: { deleted: 'Listo. Tus datos de su94r están borrados.', bad: 'Este enlace no es válido. Empieza otra vez desde la app de Alexa: su94r → Vincular cuenta.' },
  },
};

const other = (lang) => (lang === 'es' ? '<a href="?lang=en">English</a>' : '<a href="?lang=es">Español</a>');

// ─── Libre or Dexcom, and the family pages ─────────────────────────────────────────────────

const FAM = {
  en: {
    choose: 'Which sensor?', libre: 'FreeStyle Libre', dexcom: 'Dexcom (G7, G6 or ONE+)',
    libreHead: 'With FreeStyle Libre (5 minutes)', dexcomHead: 'With Dexcom (5 minutes)',
    dexcomSteps: [
      'In the <b>Dexcom</b> app open <b>Connections</b> → <b>Share</b> and turn Share on.',
      'Invite at least one follower, for example the other parent, and accept the invitation in the <b>Dexcom Follow</b> app. Dexcom Follow is the official alarm: keep its alerts on.',
      'Sign in below with the <b>Dexcom account</b>: the username and password the Dexcom app signs in with.',
    ],
    login: 'Email or username', password: 'Password',
    person: 'Name to say (Dexcom only, for example Sofia)', region: 'Dexcom region (Dexcom only)',
    regions: { us: 'United States', ous: 'Outside the United States', jp: 'Japan' },
    famTitle: 'su94r for your family',
    famIntro: 'One private account for your family. Your Echo, your screens (a Tesla, a computer, a TV), the Echo Show tile and the backup alerts show only your family, and nothing is shared with anyone else.',
    famConsents: 'First time only: tick every box.', famSubmit: 'Sign in',
    errors: {
      person: 'Type the name Alexa should say.',
      dexcom_credentials: 'Dexcom did not accept that username and password. Use the account the Dexcom app signs in with.',
      dexcom_locked: 'Dexcom locked the account for a few minutes after failed tries. Wait 10 minutes, then try once.',
      dexcom: 'Dexcom did not answer just now. Try again in a minute.',
      nodexcom: 'Dexcom has no readings to share yet. In the Dexcom app turn on Share and invite a follower, then try again.',
      expired: 'The settings page closed after 30 minutes. Sign in again.',
    },
    now: 'Now', noReading: 'No reading yet', minAgo: 'min ago', justNow: 'just now',
    readErr: { credentials: 'Sign in again: the password changed.', locked: 'Dexcom is locked for a few minutes.', error: 'Could not read right now.' },
    settings: 'Name and the doctor\'s numbers', doctorNote: 'Use the numbers from the doctor. su94r never suggests doses.',
    units: 'Units', low: 'Low (alerts below this)', severe: 'Urgent low', high: 'High (shown in amber)',
    nightStart: 'Night starts (hour 0–23)', nightEnd: 'Night ends (hour 0–23)', tz: 'Time zone',
    treat: 'Low treatment plan from the doctor (shown in the alerts)', enabled: 'Backup alerts on',
    soon: 'Warn when a low is coming ("Low soon")', echoAlways: 'Echo announces at any hour, not only at night', langAlerts: 'Alert language', save: 'Save',
    alerts: 'Alert phones (free, iPhone and Android)',
    alertSteps: ['Install the free <b>ntfy</b> app on each caregiver\'s phone and allow its notifications.', 'On that phone open this private link and tap <b>Subscribe</b>:', 'Press <b>Send a test alert</b> and check every phone got it.'],
    test: 'Send a test alert', alertsNote: 'Backup only. Dexcom Follow (or the Libre app) stays the main alarm on every caregiver\'s phone.',
    echo: 'Echo says it out loud',
    echoSteps: [
      'On your Amazon account enable the free <b>URL Routine Trigger</b> skill (by Virtual Smart Home) and link it.',
      'At virtualsmarthome.xyz → URL Routine Trigger make two triggers, for example "baby low" and "baby low soon".',
      'In the Alexa app make a routine for each: When: Smart Home → the trigger → Alexa Says → Announcement → choose your Echo devices.',
      'Paste the trigger links here, press Save, then Test the Echo.',
    ],
    echoLow: 'Trigger link for lows', echoSoon: 'Trigger link for "low soon" (optional)', echoSave: 'Save the links', echoTest: 'Test the Echo', echoClear: 'Remove the links', echoOn: 'saved', echoOff: 'not set',
    screens: 'Screens (Tesla, computer, TV, fridge)',
    screenSteps: 'On the screen open <b>su94r.com/tv</b>: it shows a 6-character code. Type it here with a name. In a Tesla, then tap ◧ View → Car.',
    code: 'Code (like K7Q-4MD)', name: 'Name (like Tesla)', pair: 'Add screen', remove: 'Remove', lastSeen: 'last seen', never: 'not yet',
    alexa: 'Alexa and the Echo Show tile',
    alexaSteps: 'In the Alexa app: Skills → su94r → Enable → Link account, and sign in with this same account. Then say "Alexa, open sugar". On an Echo Show, add the su94r widget.',
    msgs: { created: 'Your family account is ready.', saved: 'Saved.', paired: 'Screen added. It shows your family within a few seconds.', unpaired: 'Screen removed.', echo_saved: 'Echo links saved.', echo_cleared: 'Echo links removed.', test_sent: 'Test alert sent.', echo_rang: 'The Echo trigger rang.' },
    mErrors: { numbers: 'Check the numbers.', order: 'Urgent low must be under low, and high well above low.', code: 'That code does not look right (6 letters and numbers).', nocode: 'No screen is waiting with that code. Codes last 15 minutes: refresh su94r.com/tv on the screen.', echo_missing: 'Paste a trigger link first.', echo_bad: 'That is not a virtualsmarthome.xyz trigger link.', echo_ring: 'The trigger link did not answer.', push: 'The test alert could not be sent.', bad: 'Something was not right. Try again.' },
    lastCheck: 'Last safety check', signOut: 'Done', delete: 'Delete this family account',
  },
  es: {
    choose: '¿Qué sensor?', libre: 'FreeStyle Libre', dexcom: 'Dexcom (G7, G6 o ONE+)',
    libreHead: 'Con FreeStyle Libre (5 minutos)', dexcomHead: 'Con Dexcom (5 minutos)',
    dexcomSteps: [
      'En la app <b>Dexcom</b> abre <b>Conexiones</b> → <b>Compartir</b> y activa Compartir.',
      'Invita al menos a un seguidor, por ejemplo el otro padre o madre, y acepta la invitación en la app <b>Dexcom Follow</b>. Dexcom Follow es la alarma oficial: mantén sus alertas encendidas.',
      'Inicia sesión abajo con la <b>cuenta Dexcom</b>: el usuario y la contraseña con que inicia sesión la app Dexcom.',
    ],
    login: 'Correo o usuario', password: 'Contraseña',
    person: 'Nombre que se dirá (solo Dexcom, por ejemplo Sofía)', region: 'Región de Dexcom (solo Dexcom)',
    regions: { us: 'Estados Unidos', ous: 'Fuera de Estados Unidos', jp: 'Japón' },
    famTitle: 'su94r para tu familia',
    famIntro: 'Una cuenta privada para tu familia. Tu Echo, tus pantallas (un Tesla, una computadora, un televisor), el widget del Echo Show y las alertas de respaldo muestran solo a tu familia, y no se comparte nada con nadie más.',
    famConsents: 'Solo la primera vez: marca todas las casillas.', famSubmit: 'Iniciar sesión',
    errors: {
      person: 'Escribe el nombre que debe decir Alexa.',
      dexcom_credentials: 'Dexcom no aceptó ese usuario y contraseña. Usa la cuenta con la que inicia sesión la app Dexcom.',
      dexcom_locked: 'Dexcom bloqueó la cuenta unos minutos tras intentos fallidos. Espera 10 minutos y prueba una vez.',
      dexcom: 'Dexcom no respondió ahora. Inténtalo en un minuto.',
      nodexcom: 'Dexcom aún no tiene lecturas para compartir. En la app Dexcom activa Compartir e invita a un seguidor, y vuelve a intentarlo.',
      expired: 'La página de ajustes se cerró a los 30 minutos. Inicia sesión otra vez.',
    },
    now: 'Ahora', noReading: 'Aún sin lectura', minAgo: 'min', justNow: 'ahora',
    readErr: { credentials: 'Inicia sesión otra vez: la contraseña cambió.', locked: 'Dexcom está bloqueado unos minutos.', error: 'No se pudo leer ahora.' },
    settings: 'Nombre y los números del médico', doctorNote: 'Usa los números del médico. su94r nunca sugiere dosis.',
    units: 'Unidades', low: 'Baja (alerta por debajo)', severe: 'Baja urgente', high: 'Alta (en ámbar)',
    nightStart: 'Empieza la noche (hora 0–23)', nightEnd: 'Termina la noche (hora 0–23)', tz: 'Zona horaria',
    treat: 'Plan del médico para tratar una baja (aparece en las alertas)', enabled: 'Alertas de respaldo encendidas',
    soon: 'Avisar cuando viene una baja ("Baja pronto")', echoAlways: 'El Echo avisa a cualquier hora, no solo de noche', langAlerts: 'Idioma de las alertas', save: 'Guardar',
    alerts: 'Teléfonos de alerta (gratis, iPhone y Android)',
    alertSteps: ['Instala la app gratuita <b>ntfy</b> en el teléfono de cada cuidador y permite sus notificaciones.', 'En ese teléfono abre este enlace privado y toca <b>Subscribe</b>:', 'Pulsa <b>Enviar una alerta de prueba</b> y revisa que llegó a cada teléfono.'],
    test: 'Enviar una alerta de prueba', alertsNote: 'Solo de respaldo. Dexcom Follow (o la app de Libre) sigue siendo la alarma principal en el teléfono de cada cuidador.',
    echo: 'El Echo lo dice en voz alta',
    echoSteps: [
      'En tu cuenta de Amazon activa la skill gratuita <b>URL Routine Trigger</b> (de Virtual Smart Home) y vincúlala.',
      'En virtualsmarthome.xyz → URL Routine Trigger crea dos disparadores, por ejemplo "bebé baja" y "bebé baja pronto".',
      'En la app de Alexa crea una rutina para cada uno: Cuando: Hogar inteligente → el disparador → Alexa dice → Anuncio → elige tus Echo.',
      'Pega aquí los enlaces de los disparadores, pulsa Guardar y luego Probar el Echo.',
    ],
    echoLow: 'Enlace del disparador para bajas', echoSoon: 'Enlace para "baja pronto" (opcional)', echoSave: 'Guardar los enlaces', echoTest: 'Probar el Echo', echoClear: 'Quitar los enlaces', echoOn: 'guardado', echoOff: 'sin configurar',
    screens: 'Pantallas (Tesla, computadora, televisor, refrigerador)',
    screenSteps: 'En la pantalla abre <b>su94r.com/tv</b>: muestra un código de 6 caracteres. Escríbelo aquí con un nombre. En un Tesla, luego toca ◧ Vista → Auto.',
    code: 'Código (como K7Q-4MD)', name: 'Nombre (como Tesla)', pair: 'Agregar pantalla', remove: 'Quitar', lastSeen: 'visto', never: 'aún no',
    alexa: 'Alexa y el widget del Echo Show',
    alexaSteps: 'En la app de Alexa: Skills → su94r → Activar → Vincular cuenta, e inicia sesión con esta misma cuenta. Luego di "Alexa, abre sugar". En un Echo Show, agrega el widget de su94r.',
    msgs: { created: 'La cuenta de tu familia está lista.', saved: 'Guardado.', paired: 'Pantalla agregada. Muestra a tu familia en unos segundos.', unpaired: 'Pantalla quitada.', echo_saved: 'Enlaces del Echo guardados.', echo_cleared: 'Enlaces del Echo quitados.', test_sent: 'Alerta de prueba enviada.', echo_rang: 'El disparador del Echo sonó.' },
    mErrors: { numbers: 'Revisa los números.', order: 'La baja urgente debe ser menor que la baja, y la alta bastante mayor que la baja.', code: 'Ese código no parece correcto (6 letras y números).', nocode: 'Ninguna pantalla espera con ese código. Los códigos duran 15 minutos: recarga su94r.com/tv en la pantalla.', echo_missing: 'Pega primero un enlace de disparador.', echo_bad: 'Ese no es un enlace de disparador de virtualsmarthome.xyz.', echo_ring: 'El enlace del disparador no respondió.', push: 'No se pudo enviar la alerta de prueba.', bad: 'Algo no salió bien. Inténtalo otra vez.' },
    lastCheck: 'Última revisión de seguridad', signOut: 'Listo', delete: 'Borrar esta cuenta familiar',
  },
};

/** The sensor choice, the steps for each, and the sign-in fields (shared by the Alexa link and the family page). */
function signInFields(lang, { email = '', source = 'libre', person = '', region = 'us' } = {}) {
  const t = TXT[lang] || TXT.en;
  const f = FAM[lang] || FAM.en;
  const radio = (v, label) => `<label class="c"><input type="radio" name="source" value="${v}" ${source === v ? 'checked' : ''} required><span><b>${label}</b></span></label>`;
  return `
    <div class="card"><h2>${f.choose}</h2>${radio('libre', f.libre)}${radio('dexcom', f.dexcom)}</div>
    <div class="card"><h2>${f.libreHead}</h2><ol>${t.steps.map((s) => `<li>${s}</li>`).join('')}</ol><p class="muted">${t.why}</p></div>
    <div class="card"><h2>${f.dexcomHead}</h2><ol>${f.dexcomSteps.map((s) => `<li>${s}</li>`).join('')}</ol></div>
    <div class="card">
    <label class="f" for="email">${f.login}</label><input id="email" name="email" type="text" required autocomplete="username" value="${esc(email)}">
    <label class="f" for="password">${f.password}</label><input id="password" name="password" type="password" required autocomplete="current-password">
    <label class="f" for="person">${f.person}</label><input id="person" name="person" type="text" maxlength="40" value="${esc(person)}">
    <label class="f" for="region">${f.region}</label><select id="region" name="region">${Object.entries(f.regions).map(([k, v]) => `<option value="${k}" ${region === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </div>`;
}
const errText = (lang, error) => (FAM[lang] || FAM.en).errors[error] || (TXT[lang] || TXT.en).errors[error] || error;
const consentBoxes = (lang) => Object.entries((TXT[lang] || TXT.en).consents).map(([k, v]) => `<label class="c"><input type="checkbox" name="${k}" value="yes"><span>${v}</span></label>`).join('');

export function linkPage({ lang = 'en', params, error = null, email = '', source = 'libre', person = '' }) {
  const t = TXT[lang] || TXT.en;
  const hidden = ['client_id', 'redirect_uri', 'state', 'response_type'].map((k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('');
  const langLink = `<a href="?${new URLSearchParams({ ...params, lang: lang === 'es' ? 'en' : 'es' })}">${lang === 'es' ? 'English' : 'Español'}</a>`;
  return shell(lang, t.title, `
    <span class="lang">${langLink}</span>
    <h1>${t.title}</h1>
    <p>${t.intro}</p>
    ${error ? `<div class="card err" role="alert">${esc(errText(lang, error))}</div>` : ''}
    <form method="post" action="/sugar/link" autocomplete="on">
      ${hidden}<input type="hidden" name="lang" value="${lang}">
      ${signInFields(lang, { email, source, person })}
      <div class="card">${consentBoxes(lang).replaceAll('value="yes">', 'value="yes" required>')}
      <button type="submit">${t.submit}</button></div>
    </form>
    <p class="muted">${t.footer}</p>`);
}

export function familySignInPage({ lang = 'en', error = null, email = '', source = 'libre', person = '' } = {}) {
  const t = TXT[lang] || TXT.en;
  const f = FAM[lang] || FAM.en;
  return shell(lang, f.famTitle, `
    <span class="lang">${other(lang)}</span>
    <h1>${f.famTitle}</h1>
    <p>${f.famIntro}</p>
    ${error ? `<div class="card err" role="alert">${esc(errText(lang, error))}</div>` : ''}
    <form method="post" action="/sugar/family" autocomplete="on">
      <input type="hidden" name="lang" value="${lang}">
      ${signInFields(lang, { email, source, person })}
      <div class="card"><p class="muted">${f.famConsents}</p>${consentBoxes(lang)}
      <button type="submit">${f.famSubmit}</button></div>
    </form>
    <p class="muted">${t.footer}</p>`);
}

/** The family settings page: every form posts back with the 30-minute settings token. */
export function managePage({ lang = 'en', token, message = null, error = null, family, reading, readError, screens = [], zones = [] }) {
  const f = FAM[lang] || FAM.en;
  const hid = (action) => `<input type="hidden" name="m" value="${esc(token)}"><input type="hidden" name="lang" value="${lang}"><input type="hidden" name="action" value="${action}">`;
  const form = (action, inner, cls = '') => `<form method="post" action="/sugar/manage" class="${cls}">${hid(action)}${inner}</form>`;
  const field = (id, label, value, attrs = '') => `<label class="f" for="${id}">${label}</label><input id="${id}" name="${id}" value="${esc(value)}" ${attrs}>`;
  const check = (id, label, on) => `<label class="c"><input type="checkbox" name="${id}" value="yes" ${on ? 'checked' : ''}><span>${label}</span></label>`;
  const who = family.person || (family.source === 'dexcom' ? 'Dexcom' : 'Libre');
  const mins = reading ? Math.max(0, Math.round((Date.now() - reading.t) / 60e3)) : null;
  const value = reading ? (family.units === 'mmol/L' ? (reading.mg / 18.0182).toFixed(1) : Math.round(reading.mg)) : null;
  const arrow = reading ? ['', '↓', '↘', '→', '↗', '↑'][reading.trend] || '' : '';
  const now = reading ? `<b style="font-size:2rem">${value} ${arrow}</b> <span class="muted">${mins < 1 ? f.justNow : `${mins} ${f.minAgo}`}</span>` : `<span class="muted">${esc(readError ? f.readErr[readError] || f.readErr.error : f.noReading)}</span>`;
  const sel = (id, opts, cur) => `<select id="${id}" name="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return shell(lang, `su94r · ${who}`, `
    <h1>su94r · ${esc(who)}</h1>
    ${message ? `<div class="card" role="status">${esc(f.msgs[message] || message)}</div>` : ''}
    ${error ? `<div class="card err" role="alert">${esc(f.mErrors[error] || f.errors[error] || error)}</div>` : ''}
    <div class="card"><h2>${f.now}</h2>${now}${family.lastCheck ? `<p class="muted">${f.lastCheck}: ${esc(new Date(family.lastCheck).toLocaleString('en-US', { timeZone: family.timeZone }))}</p>` : ''}</div>

    ${form('settings', `<h2>${f.settings}</h2><p class="muted">${f.doctorNote}</p>
      ${family.source === 'dexcom' ? field('person', f.person, family.person, 'maxlength="40"') : ''}
      <label class="f" for="units">${f.units}</label>${sel('units', [['mg/dL', 'mg/dL'], ['mmol/L', 'mmol/L']], family.units)}
      ${field('low', `${f.low} (mg/dL)`, family.low, 'type="number" min="55" max="120" required')}
      ${field('severe', `${f.severe} (mg/dL)`, family.severe, 'type="number" min="40" max="100" required')}
      ${field('high', `${f.high} (mg/dL)`, family.high, 'type="number" min="120" max="400" required')}
      ${field('night_start', f.nightStart, family.nightStart, 'type="number" min="0" max="23" required')}
      ${field('night_end', f.nightEnd, family.nightEnd, 'type="number" min="0" max="23" required')}
      <label class="f" for="time_zone">${f.tz}</label>${sel('time_zone', zones.map((z) => [z, z.replace('_', ' ')]), family.timeZone)}
      ${field('treat_plan', f.treat, family.treatPlan, 'maxlength="140"')}
      <label class="f" for="lang_alerts">${f.langAlerts}</label>${sel('lang_alerts', [['en', 'English'], ['es', 'Español']], family.langAlerts)}
      ${check('enabled', f.enabled, family.enabled)}${check('soon', f.soon, family.soon)}${check('echo_always', f.echoAlways, family.echoAlways)}
      <button type="submit">${f.save}</button>`, 'card')}

    <div class="card"><h2>${f.alerts}</h2><ol>
      <li>${f.alertSteps[0]}</li><li>${f.alertSteps[1]}<br><a href="${esc(family.topicUrl)}">${esc(family.topicUrl)}</a></li><li>${f.alertSteps[2]}</li></ol>
      ${form('test_alert', `<button type="submit">${f.test}</button>`)}
      <p class="muted">${f.alertsNote}</p></div>

    <div class="card"><h2>${f.echo}</h2><ol>${f.echoSteps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <p class="muted">${f.echoLow}: ${family.echoLow ? f.echoOn : f.echoOff} · ${f.echoSoon}: ${family.echoSoon ? f.echoOn : f.echoOff}</p>
      ${form('echo', `${field('echo_low', f.echoLow, '', 'type="password" autocomplete="off"')}${field('echo_soon', f.echoSoon, '', 'type="password" autocomplete="off"')}<button type="submit">${f.echoSave}</button>`)}
      ${family.echoLow ? form('test_echo', `<button type="submit">${f.echoTest}</button>`) + form('echo_clear', `<button type="submit" class="danger">${f.echoClear}</button>`) : ''}</div>

    <div class="card"><h2>${f.screens}</h2><p>${f.screenSteps}</p>
      ${screens.length ? `<ul>${screens.map((s) => `<li>${esc(s.name || 'Screen')} <span class="muted">(${f.lastSeen}: ${s.last_seen ? esc(new Date(s.last_seen).toLocaleString('en-US', { timeZone: family.timeZone })) : f.never})</span>${form('unpair', `<input type="hidden" name="id" value="${esc(s.id)}"><button type="submit" class="danger">${f.remove}</button>`)}</li>`).join('')}</ul>` : ''}
      ${form('pair', `${field('code', f.code, '', 'maxlength="8" required autocomplete="off"')}${field('name', f.name, '', 'maxlength="40"')}<button type="submit">${f.pair}</button>`)}</div>

    <div class="card"><h2>${f.alexa}</h2><p>${f.alexaSteps}</p></div>
    <p class="muted"><a href="/sugar/family${lang === 'es' ? '?lang=es' : ''}">${f.signOut}</a> · <a href="/sugar/delete${lang === 'es' ? '?lang=es' : ''}">${f.delete}</a></p>`);
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
