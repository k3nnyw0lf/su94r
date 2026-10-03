// The su94r phone app (served by su94r-proxy as /app/app.js, after REPORT_SCRIPT from
// workers/doctor.js, which supplies esc() and reportHtml()). Server routes: workers/app.js.
//
// The phone's token is the one it got from a share code (su94r Mini → Share to another phone);
// it is kept in this browser's storage under the same name the /tv page uses, so a phone linked
// there already has the app. Nothing here dials out anywhere but this server.
//
// English and Spanish: every phone picks its own language (More → Language); t() turns the
// English text into Spanish from ES below, and the server answers in the same language
// (X-Su94r-Lang).
(() => {
  'use strict';
  const K = { token: 'su94rScreenToken', role: 'su94rShared', ns: 'su94rNsToken', last: 'su94rAppLast', me: 'su94rAppMe', tab: 'su94rAppTab', pid: 'su94rAppPid', range: 'su94rAppRange', days: 'su94rAppDays', lang: 'su94rAppLang' };
  const mem = {};
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return k in mem ? mem[k] : null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { delete mem[k]; } },
  };
  const readJson = (k) => { try { return JSON.parse(store.get(k) || 'null'); } catch (e) { return null; } };
  const $ = (id) => document.getElementById(id);
  const MIN = 60e3, HOUR = 3600e3, DAY = 864e5;
  const ARROW = ['', '↓', '↘', '→', '↗', '↑'];

  // ---------- language ----------
  const ES = {
    // tabs and common
    'Now': 'Ahora', 'History': 'Historial', 'Log': 'Registrar', 'Report': 'Informe', 'More': 'Más',
    'Loading…': 'Cargando…', 'Cancel': 'Cancelar', 'Close': 'Cerrar', 'Save': 'Guardar', 'Remove': 'Quitar', 'Removed.': 'Quitado.', 'Saved.': 'Guardado.',
    'Undo': 'Deshacer', 'Copy': 'Copiar', 'Copied': 'Copiado', 'Person': 'Persona', 'Edit': 'Editar',
    'Today': 'Hoy', 'Yesterday': 'Ayer', 'just now': 'ahora mismo', '{m} min ago': 'hace {m} min', '{h} h {m} min ago': 'hace {h} h {m} min',
    'This phone is no longer linked.': 'Este teléfono ya no está vinculado.', 'The server answered {s}.': 'El servidor respondió {s}.',
    'Updated {ago}': 'Actualizado {ago}', 'Offline · last {time}': 'Sin conexión · última {time}',
    // linking
    'Linking this phone…': 'Vinculando este teléfono…', 'That code did not work ({s}).': 'Ese código no funcionó ({s}).',
    'su94r on this phone': 'su94r en este teléfono',
    'Live glucose, history, logging and your 14-day report, with every computer off.': 'Glucosa en vivo, historial, registros y tu informe de 14 días, con todas las computadoras apagadas.',
    'On your computer open <b>su94r Mini → Health vault → Share to another phone</b>.': 'En tu computadora abre <b>su94r Mini → Health vault → Share to another phone</b>.',
    'Press <b>My other phone</b> (or <b>A family member\'s phone</b>).': 'Pulsa <b>My other phone</b> (o <b>A family member\'s phone</b>).',
    'Scan the code with this phone\'s camera and open the link.': 'Escanea el código con la cámara de este teléfono y abre el enlace.',
    'Linked before on this phone\'s /tv page? Open this app in that same browser.': '¿Ya lo vinculaste en la página /tv de este teléfono? Abre esta app en ese mismo navegador.',
    'This phone was removed in su94r Mini, so it no longer shows the glucose. Scan a new code to link it again.': 'Este teléfono se quitó en su94r Mini y ya no muestra la glucosa. Escanea un código nuevo para vincularlo otra vez.',
    // graph and Now
    'Glucose graph': 'Gráfica de glucosa', 'in range': 'en rango', 'low': 'baja', 'high': 'alta', 'insulin': 'insulina', 'carbs': 'carbohidratos',
    'Waiting for the first reading…': 'Esperando la primera lectura…', 'Offline, and no reading saved on this phone yet.': 'Sin conexión y sin lecturas guardadas en este teléfono todavía.',
    'Offline · showing the last reading this phone saw': 'Sin conexión · mostrando la última lectura que vio este teléfono',
    'A low alert is waiting': 'Hay una alerta de baja pendiente', 'Tap once it is handled; the reminders stop.': 'Tócalo cuando esté atendida; los recordatorios paran.', 'I\'m OK': 'Estoy bien',
    'Treating: {g} g at {time}': 'Tratando: {g} g a las {time}', 'Recheck at {time}, in {n} min.': 'Volver a revisar a las {time}, en {n} min.', 'Time to recheck.': 'Hora de volver a revisar.',
    'Logged on {who}.': 'Registrado en {who}.', 'su94r tells you at the recheck where it went. Still low, the reminders start again.': 'su94r te dice en la revisión cómo va. Si sigue baja, los recordatorios vuelven a empezar.',
    'Treat the low': 'Tratar la baja', 'Your plan: {plan}': 'Tu plan: {plan}', 'I treated it with {g} g': 'La traté con {g} g',
    'Logs the carbs, stops the reminders, and rechecks in {n} min.': 'Registra los carbohidratos, para los recordatorios y vuelve a revisar en {n} min.',
    'falling fast': 'bajando rápido', 'falling': 'bajando', 'steady': 'estable', 'rising': 'subiendo', 'rising fast': 'subiendo rápido',
    '{d} in 15 min · ': '{d} en 15 min · ', 'no reading yet': 'sin lecturas todavía', 'Urgent low': 'Baja urgente', 'Low': 'Baja', '{what}: below {v} {u}': '{what}: por debajo de {v} {u}',
    'No new reading for {t}. The sensor or the phone running LibreLink may be out of range.': 'Sin lecturas nuevas desde hace {t}. El sensor o el teléfono con LibreLink pueden estar fuera de alcance.',
    'Hours shown': 'Horas mostradas', 'Glucose for the last {n} hours': 'Glucosa de las últimas {n} horas',
    'Where it may head': 'Hacia dónde puede ir', 'In 30 min': 'En 30 min', 'In 1 hour': 'En 1 hora', '<b>{when}</b>: about {v} ({lo}–{hi})': '<b>{when}</b>: unos {v} ({lo}–{hi})',
    'An estimate from su94r Mini\'s learner, made {ago} from your own past data. Not a reason to dose.': 'Un estimado del aprendizaje de su94r Mini, hecho {ago} con tus propios datos. No es una razón para dosificar.',
    'Sensor has ended': 'El sensor terminó', 'Sensor ends today at {time}': 'El sensor termina hoy a las {time}', 'Sensor ends tomorrow at {time}': 'El sensor termina mañana a las {time}',
    'Sensor ends in {n} days ({date})': 'El sensor termina en {n} días ({date})',
    // History
    'Days shown': 'Días mostrados', '1 day': '1 día', '{n} d': '{n} d', 'Loading {n} days of readings…': 'Cargando {n} días de lecturas…', 'Loading 1 day of readings…': 'Cargando 1 día de lecturas…',
    'The server has no readings for this period yet. It saves every reading from now on, and su94r Mini on your computer copies its own history once.': 'El servidor todavía no tiene lecturas de este periodo. Guarda cada lectura desde ahora, y su94r Mini en tu computadora copia su propio historial una vez.',
    '‹ Back': '‹ Atrás', 'average': 'promedio', 'lowest': 'más baja', 'highest': 'más alta', 'lows': 'bajas', 'GMI': 'GMI', 'Glucose on {day}': 'Glucosa el {day}',
    '{b} below · {a} above · readings for {c} of the time': '{b} por debajo · {a} por encima · lecturas el {c} del tiempo',
    'Glucose for the last {n} days': 'Glucosa de los últimos {n} días',
    'The server has readings from {day}. Each day fills in more; su94r Mini on your computer also copies the history it has kept.': 'El servidor tiene lecturas desde {day}. Cada día se llena más; su94r Mini en tu computadora también copia el historial que guardó.',
    'Patterns': 'Patrones', 'From the last 14 days. It describes what repeated; it does not advise.': 'De los últimos 14 días. Describe lo que se repitió; no aconseja.', 'No clear patterns yet.': 'Todavía no hay patrones claros.',
    'Day by day': 'Día por día', 'Tap a day to see it.': 'Toca un día para verlo.',
    // Log
    'Nothing logged in the last 48 hours.': 'Nada registrado en las últimas 48 horas.', 'Logging': 'Registros',
    'This phone shows the glucose and the history. It can\'t log yet: the owner can allow it in su94r Mini (Share to another phone) or in their own su94r app (More).': 'Este teléfono muestra la glucosa y el historial. Todavía no puede registrar: el dueño lo puede permitir en su94r Mini (Share to another phone) o en su propia app su94r (Más).',
    'Last 48 hours': 'Últimas 48 horas', 'Rapid insulin': 'Insulina rápida', 'Long-acting': 'Acción prolongada', 'Carbs': 'Carbohidratos', 'Other insulin': 'Otra insulina',
    'Regular': 'Regular', 'NPH': 'NPH', 'Pre-mixed': 'Premezclada', 'Less': 'Menos', 'grams': 'gramos', 'units': 'unidades', 'When': 'Cuándo',
    '15 min ago': 'hace 15 min', '30 min ago': 'hace 30 min', '1 h ago': 'hace 1 h', '2 h ago': 'hace 2 h', 'Log {what}': 'Registrar {what}', 'Choose an amount': 'Elige una cantidad',
    'Logged doses reach su94r Mini, Alexa and the double-dose check. su94r never suggests a dose.': 'Las dosis registradas llegan a su94r Mini, Alexa y la revisión de doble dosis. su94r nunca sugiere una dosis.',
    '📷 Estimate from a photo': '📷 Estimar con una foto', 'Looking at the photo…': 'Mirando la foto…',
    'About <b>{g} g</b> of carbs (likely {lo}–{hi} g, {conf} confidence)': 'Unos <b>{g} g</b> de carbohidratos (probablemente {lo}–{hi} g, confianza {conf})',
    'Photo estimates are rough: check the number before logging.': 'Los estimados por foto son aproximados: revisa el número antes de registrar.', 'about {g} g': 'unos {g} g',
    '🎤 Say it: "4 units rapid" or "40 grams"': '🎤 Dilo: "4 unidades de rápida" o "40 gramos"', '🎤 Listening…': '🎤 Escuchando…',
    'The microphone is blocked for su94r. Allow it in the browser settings.': 'El micrófono está bloqueado para su94r. Permítelo en la configuración del navegador.',
    'Did not catch that. Try again.': 'No lo entendí. Intenta otra vez.', 'Heard "{t}".': 'Escuché "{t}".',
    'Log {what}, {when}?': '¿Registrar {what}, {when}?', 'now': 'ahora', 'For {name}.': 'Para {name}.', 'Log it': 'Registrar', 'Not logged': 'No se registró',
    'Log {what} anyway?': '¿Registrar {what} de todos modos?', 'Check before logging a second dose.': 'Revisa antes de registrar una segunda dosis.', 'Log anyway': 'Registrar de todos modos',
    'This phone could not open that photo.': 'Este teléfono no pudo abrir esa foto.', 'The photo check answered {s}.': 'La revisión de la foto respondió {s}.',
    'Could not read that photo. Type the grams instead.': 'No se pudo leer esa foto. Escribe los gramos.', 'No food seen in that photo. Type the grams instead.': 'No se ve comida en esa foto. Escribe los gramos.',
    // treating
    'Log {g} g to treat the low?': '¿Registrar {g} g para tratar la baja?', 'The reminders stop, and su94r rechecks in {n} minutes.': 'Los recordatorios paran y su94r vuelve a revisar en {n} minutos.',
    'Got it. Reminders for this low stop.': 'Entendido. Los recordatorios de esta baja paran.', 'That alert was already answered.': 'Esa alerta ya se respondió.', 'Could not reach the server. Try again.': 'No se pudo conectar con el servidor. Intenta otra vez.',
    // Report and labs
    'Making the 14-day report…': 'Preparando el informe de 14 días…', 'Print or save as PDF': 'Imprimir o guardar como PDF',
    'For your doctor: su94r Mini → Health vault → <b>Live link for my doctor</b> makes a private link that always shows this report.': 'Para tu médico: su94r Mini → Health vault → <b>Live link for my doctor</b> crea un enlace privado que siempre muestra este informe.',
    'Lab results': 'Resultados de laboratorio', 'None yet. An A1c typed in here shows in the report and the doctor\'s link next to the GMI.': 'Ninguno todavía. Una A1c anotada aquí aparece en el informe y en el enlace del médico junto al GMI.',
    'Add a lab result': 'Agregar un resultado', 'Test': 'Prueba', 'A1c (%)': 'A1c (%)', 'Another test': 'Otra prueba', 'Name': 'Nombre', 'for example LDL cholesterol': 'por ejemplo colesterol LDL',
    'Unit': 'Unidad', 'for example mg/dL': 'por ejemplo mg/dL', 'Result': 'Resultado', 'Date of the test': 'Fecha de la prueba', 'Saved. It shows in the report.': 'Guardado. Aparece en el informe.',
    // supplies
    'Supplies': 'Suministros', 'Add supplies': 'Agregar suministros', 'What': 'Qué', 'On hand now (units of insulin, or sensors)': 'Lo que tienes ahora (unidades de insulina o sensores)',
    'A U-100 pen holds 300 units; a 10 mL vial 1000.': 'Una pluma U-100 trae 300 unidades; un frasco de 10 mL, 1000.', 'Remind me when it is down to': 'Avísame cuando quede',
    'for example 300 units, or 1 sensor': 'por ejemplo 300 unidades o 1 sensor', 'Refill date (optional)': 'Fecha de surtido (opcional)',
    'Long-acting insulin': 'Insulina de acción prolongada', 'Regular insulin': 'Insulina regular', 'NPH insulin': 'Insulina NPH', 'Pre-mixed insulin': 'Insulina premezclada', 'Sensors': 'Sensores',
    '{n} {u} left': 'quedan {n} {u}', 'sensors': 'sensores', 'refill {date}': 'surtido {date}', 'Nothing tracked yet.': 'Nada en seguimiento todavía.', 'Add insulin or sensors': 'Agregar insulina o sensores',
    'Counts down as doses are logged (pen priming is not counted) and as new sensors start. su94r reminds you by day when it runs low or a refill is due.': 'Baja la cuenta con cada dosis registrada (sin contar el cebado de la pluma) y con cada sensor nuevo. su94r te avisa de día cuando queda poco o toca surtir.',
    // More
    'Installed. Open su94r from the home screen.': 'Instalada. Abre su94r desde la pantalla de inicio.', 'Put su94r on the home screen like any app.': 'Pon su94r en la pantalla de inicio como cualquier app.', 'Install su94r': 'Instalar su94r',
    'In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>.': 'En Safari toca <b>Compartir</b> y luego <b>Agregar a inicio</b>.', 'In Chrome tap <b>⋮</b>, then <b>Install app</b> or <b>Add to Home screen</b>.': 'En Chrome toca <b>⋮</b> y luego <b>Instalar app</b> o <b>Agregar a la pantalla principal</b>.',
    'This phone is linked. Turn on its low alerts below, and install the app.': 'Este teléfono está vinculado. Enciende sus alertas de baja abajo e instala la app.',
    'Low alerts in this app': 'Alertas de baja en esta app', 'Install': 'Instalar',
    'On iPhone, install the app first (Safari: Share → <b>Add to Home Screen</b>), open it from the home screen, then turn alerts on here.': 'En iPhone, instala primero la app (Safari: Compartir → <b>Agregar a inicio</b>), ábrela desde la pantalla de inicio y luego enciende las alertas aquí.',
    'This browser cannot show alerts from the app. Use ntfy or Telegram below.': 'Este navegador no puede mostrar alertas de la app. Usa ntfy o Telegram abajo.',
    'Notifications are blocked for su94r on this phone. Allow them in the phone\'s settings, then come back here.': 'Las notificaciones están bloqueadas para su94r en este teléfono. Permítelas en la configuración del teléfono y vuelve aquí.',
    'On.': 'Encendidas.', 'This phone rings when a low is not handled (once the owner switches on “Tell caregivers too”).': 'Este teléfono suena cuando una baja no se atiende (cuando el dueño encienda “Tell caregivers too”).',
    'This phone rings for every low until “I\'m OK”, for Low soon and for sensor warnings.': 'Este teléfono suena con cada baja hasta “Estoy bien”, con “baja pronto” y con avisos del sensor.',
    'Send a test': 'Enviar una prueba', 'Turn off': 'Apagar', 'Ring this phone when a low is not handled.': 'Que este teléfono suene cuando una baja no se atienda.',
    'Ring this phone for lows, with an “I\'m OK” button. No other app needed.': 'Que este teléfono suene con las bajas, con un botón “Estoy bien”. No hace falta otra app.', 'Ring for lows on this phone': 'Sonar con las bajas en este teléfono',
    'Your phone\'s silent and Do Not Disturb settings still apply; for nights, let su94r (or Chrome) through.': 'El modo silencio y No molestar del teléfono siguen aplicando; para las noches, deja pasar a su94r (o a Chrome).',
    'Also on ntfy or Telegram': 'También en ntfy o Telegram', 'You are told when a low is not handled.': 'Te avisan cuando una baja no se atiende.', ' The owner has not switched family alerts on yet.': ' El dueño todavía no encendió las alertas para la familia.',
    'The same alerts as the owner: every low, repeated until “I\'m OK”.': 'Las mismas alertas que el dueño: cada baja, repetida hasta “Estoy bien”.', ' The same alerts can also come through <b>ntfy</b> (free) or Telegram.': ' Las mismas alertas también pueden llegar por <b>ntfy</b> (gratis) o Telegram.',
    'Subscribe in ntfy': 'Suscribirse en ntfy', 'Open in the browser': 'Abrir en el navegador', 'Get ntfy:': 'Obtén ntfy:', 'Or in ntfy tap + and paste': 'O en ntfy toca + y pega',
    'Low alerts are not set up on the server yet: su94r Mini → Health vault → Low alerts.': 'Las alertas de baja todavía no están configuradas en el servidor: su94r Mini → Health vault → Low alerts.',
    'Prefer Telegram? <a class="btn ghost" href="{url}">Open in Telegram</a> then press <b>Start</b>. The link works once, for 15 minutes.': '¿Prefieres Telegram? <a class="btn ghost" href="{url}">Abrir en Telegram</a> y pulsa <b>Iniciar</b>. El enlace funciona una vez, por 15 minutos.',
    'Watch and widgets': 'Reloj y widgets', 'In <b>GlucoDataHandler</b> (free, also on the Pixel Watch): Sources → Nightscout, with this address and token.': 'En <b>GlucoDataHandler</b> (gratis, también en el Pixel Watch): Sources → Nightscout, con esta dirección y token.',
    'Family phones': 'Teléfonos de la familia', 'Could not load the family phones.': 'No se pudieron cargar los teléfonos de la familia.',
    'No family phones linked yet. Make a family code in su94r Mini → Share to another phone.': 'Todavía no hay teléfonos de la familia. Crea un código de familia en su94r Mini → Share to another phone.',
    'A family member who lives with you can log doses and meals too. Their doses get the same double-dose check.': 'Un familiar que vive contigo también puede registrar dosis y comidas. Sus dosis pasan por la misma revisión de doble dosis.',
    'can log': 'puede registrar', 'reads only': 'solo lee', 'Stop logging': 'Quitar registros', 'Allow logging': 'Permitir registros',
    'That phone can log now.': 'Ese teléfono ya puede registrar.', 'That phone reads only now.': 'Ese teléfono ahora solo lee.',
    'This phone': 'Este teléfono', 'A family member\'s phone: it reads and logs (the owner allowed it).': 'Teléfono de un familiar: lee y registra (el dueño lo permitió).',
    'A family member\'s phone: it reads; the owner can allow it to log.': 'Teléfono de un familiar: lee; el dueño le puede permitir registrar.', 'Your own phone: it reads and logs.': 'Tu propio teléfono: lee y registra.',
    ' Named “{name}” in su94r Mini.': ' Se llama “{name}” en su94r Mini.', 'Unlink this phone': 'Desvincular este teléfono',
    'su94r · not a medical device. Readings come from LibreLinkUp and can be a few minutes behind.': 'su94r · no es un dispositivo médico. Las lecturas vienen de LibreLinkUp y pueden llevar unos minutos de atraso.',
    'Language': 'Idioma', 'Unlink this phone?': '¿Desvincular este teléfono?', 'Unlink': 'Desvincular',
    'It stops showing the glucose here. To link it again, scan a new code from su94r Mini.': 'Deja de mostrar la glucosa aquí. Para vincularlo otra vez, escanea un código nuevo de su94r Mini.',
    'Alerts are on. Send a test to hear one.': 'Las alertas están encendidas. Envía una prueba para escuchar una.', 'App alerts are off on this phone.': 'Las alertas de la app están apagadas en este teléfono.',
    'Test sent. It should ring in a few seconds.': 'Prueba enviada. Debe sonar en unos segundos.',
    'The app is still installing its helper. Try again in a moment.': 'La app todavía está instalando su ayudante. Intenta en un momento.',
    'Notifications were not allowed. Allow them for su94r in the phone\'s settings, then try again.': 'No se permitieron las notificaciones. Permítelas para su94r en la configuración del teléfono e intenta otra vez.',
    // source names, kinds and amounts
    'phone': 'teléfono', 'meal': 'comida', 'rapid': 'rápida', 'regular': 'regular', 'long-acting': 'de acción prolongada', 'pre-mixed': 'premezclada',
    '{n} g of carbs': '{n} g de carbohidratos', '{n} unit of {k} insulin': '{n} unidad de insulina {k}', '{n} units of {k} insulin': '{n} unidades de insulina {k}', '{n} g carbs': '{n} g carbohidratos',
  };
  const S = {
    me: null, live: null, liveAt: 0, online: true, recent: null,
    tab: store.get(K.tab) || 'now', pid: store.get(K.pid), range: Number(store.get(K.range)) || 6,
    days: Number(store.get(K.days)) || 14, hist: {}, report: {}, extras: null, dayView: null,
    log: { kind: 'rapid', amount: 0, ago: 0, meal: null }, installEvt: null, justLinked: false,
    pendingAck: null, treatGrams: null,
    lang: store.get(K.lang) || (/^es/i.test(navigator.language || '') ? 'es' : 'en'),
  };
  /** The text in this phone's language, with {name} filled in. */
  function t(en, v) {
    let s = (S.lang === 'es' && ES[en]) || en;
    if (v) s = s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m));
    return s;
  }
  const LOC = () => (S.lang === 'es' ? 'es-US' : undefined);
  const KIND = () => ({ rapid: t('rapid'), short: t('regular'), intermediate: 'NPH', basal: t('long-acting'), mix: t('pre-mixed') });
  const SOURCE = () => ({ phone: t('phone'), extension: 'su94r Mini', alexa: 'Alexa', telegram: 'Telegram' });
  const ARROW_WORD = () => ['', t('falling fast'), t('falling'), t('steady'), t('rising'), t('rising fast')];

  // ---------- helpers ----------
  const fmt = (mg, units) => (mg < 40 ? 'LO' : mg > 400 ? 'HI' : units === 'mmol/L' ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));
  const fmtDelta = (d, units) => (d == null ? '' : (d < 0 ? '−' : '+') + (units === 'mmol/L' ? Math.abs(d / 18.0182).toFixed(1) : Math.abs(Math.round(d))));
  const clock = (ms) => new Date(ms).toLocaleTimeString(LOC(), { hour: 'numeric', minute: '2-digit' });
  const dateKey = (ms) => new Date(ms).toDateString();
  function dayLabel(ms) {
    const k = dateKey(ms);
    if (k === dateKey(Date.now())) return t('Today');
    if (k === dateKey(Date.now() - DAY)) return t('Yesterday');
    return new Date(ms).toLocaleDateString(LOC(), { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / MIN);
    if (m < 1) return t('just now');
    if (m < 60) return t('{m} min ago', { m });
    return t('{h} h {m} min ago', { h: Math.floor(m / 60), m: m % 60 });
  }
  const what = (kind, amount) => (kind === 'carbs' ? t('{n} g of carbs', { n: amount }) : t(amount === 1 ? '{n} unit of {k} insulin' : '{n} units of {k} insulin', { n: amount, k: KIND()[kind] }));
  const short = (e) => (e.type === 'meal' ? (e.amount ? t('{n} g carbs', { n: e.amount }) : t('meal')) : (e.amount ? e.amount + ' u ' : '') + (KIND()[e.kind] || e.kind || t('insulin')));
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
      headers: Object.assign({ Authorization: 'Bearer ' + store.get(K.token), 'X-Su94r-Lang': S.lang }, o.body ? { 'Content-Type': 'application/json' } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { unlinked(); throw new Error(t('This phone is no longer linked.')); }
    if (!res.ok) throw new Error(j.error || t('The server answered {s}.', { s: res.status }));
    return j;
  }

  /** The page's fixed words (tab names) and its language. */
  function chrome() {
    document.documentElement.lang = S.lang;
    document.querySelectorAll('#tabs button').forEach((b) => {
      const span = b.querySelector('span');
      if (span) span.textContent = t({ now: 'Now', history: 'History', log: 'Log', report: 'Report', more: 'More' }[b.dataset.tab]);
    });
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
    el.innerHTML = list.map((p) => '<button class="chip" data-pid="' + esc(p.pid) + '" aria-pressed="' + (p.pid === me.pid) + '">' + esc(p.name || t('Person')) + '</button>').join('');
  }

  // ---------- linking ----------
  async function join() {
    const m = /[#&]join=([0-9a-f]{64})/.exec(location.hash || '');
    if (!m) return;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* fine */ }
    main('<p class="muted">' + t('Linking this phone…') + '</p>');
    const r = await fetch('/share/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: m[1] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      if (store.get(K.token)) return;     // linked before: just carry on
      throw new Error(j.error || t('That code did not work ({s}).', { s: r.status }));
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
    main('<div class="welcome"><img src="/app/icon-192.png" alt=""><h2>' + t('su94r on this phone') + '</h2>' +
      (problem ? '<div class="banner stale">' + esc(problem) + '</div>' : '') +
      '<p>' + t('Live glucose, history, logging and your 14-day report, with every computer off.') + '</p>' +
      '<ol><li>' + t('On your computer open <b>su94r Mini → Health vault → Share to another phone</b>.') + '</li>' +
      '<li>' + t('Press <b>My other phone</b> (or <b>A family member\'s phone</b>).') + '</li>' +
      '<li>' + t('Scan the code with this phone\'s camera and open the link.') + '</li></ol>' +
      '<p class="muted small">' + t('Linked before on this phone\'s /tv page? Open this app in that same browser.') + '</p>' +
      '<div class="segm" role="group" aria-label="Language" style="max-width:260px;margin:16px auto 0"><button data-lang="en" aria-pressed="' + (S.lang === 'en') + '">English</button><button data-lang="es" aria-pressed="' + (S.lang === 'es') + '">Español</button></div></div>');
  }
  function unlinked() {
    [K.token, K.role, K.ns, K.last, K.me].forEach((k) => store.del(k));
    welcome(t('This phone was removed in su94r Mini, so it no longer shows the glucose. Scan a new code to link it again.'));
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
      ? '<span class="dot"></span>' + esc(t('Updated {ago}', { ago: ago(S.live.at || S.liveAt) }))
      : '<span class="dot off"></span>' + esc(t('Offline · last {time}', { time: clock(S.live.at || S.liveAt) }));
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
    const X = (ms) => pl + ((ms - from) / (to - from)) * (w - pl - pr);
    const Y = (v) => pt + (1 - (Math.min(top, Math.max(bot, v)) - bot) / (top - bot)) * (h - pt - pb);
    let s = '<svg class="g" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(o.label || t('Glucose graph')) + '">';
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
    for (let ms = t0.getTime(); ms <= to; ms += step) {
      if (ms < from) continue;
      const lab = step >= DAY ? new Date(ms).toLocaleDateString(LOC(), step >= 7 * DAY ? { month: 'short', day: 'numeric' } : { weekday: 'short' })
        : step >= 12 * HOUR ? new Date(ms).toLocaleString(LOC(), { weekday: 'short', hour: 'numeric' }) : new Date(ms).toLocaleTimeString(LOC(), { hour: 'numeric', minute: step < HOUR ? '2-digit' : undefined });
      s += '<line x1="' + X(ms) + '" x2="' + X(ms) + '" y1="' + pt + '" y2="' + (h - pb) + '" style="stroke:var(--soft)"/>';
      s += '<text x="' + X(ms) + '" y="' + (h - 6) + '" text-anchor="middle">' + esc(lab) + '</text>';
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
  const legend = () => '<div class="legend"><span><i style="background:var(--in)"></i>' + t('in range') + '</span><span><i style="background:var(--l)"></i>' + t('low') + '</span><span><i style="background:var(--h)"></i>' + t('high') + '</span><span><i style="background:var(--accent)"></i>' + t('insulin') + '</span><span><i style="background:var(--h);border-radius:50%"></i>' + t('carbs') + '</span></div>';

  // ---------- Now ----------
  function renderNow() {
    const c = cur();
    const L = c.live;
    if (!L) { main(card(S.online ? '<p class="muted">' + t('Waiting for the first reading…') + '</p>' : '<p class="muted">' + t('Offline, and no reading saved on this phone yet.') + '</p>')); return; }
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
    if (!S.online) html += '<div class="banner off">' + t('Offline · showing the last reading this phone saw') + '</div>';
    if (S.pendingAck) html += card('<h2>' + t('A low alert is waiting') + '</h2><p>' + t('Tap once it is handled; the reminders stop.') + '</p><button class="btn wide" id="ackBtn">' + t('I\'m OK') + '</button>');
    const lowNow = l && !stale && l.mg < L.low;
    const ep = S.recent && S.recent.lows ? S.recent.lows[c.pid] : null;
    const tr = S.recent && S.recent.treating ? S.recent.treating[c.pid] : null;
    const plan = (S.recent && S.recent.plan) || { grams: 15, minutes: 15, text: '' };
    if (tr && !tr.done) {
      const left = Math.max(0, Math.round((tr.recheckAt - now) / MIN));
      html += card('<h2>' + esc(t('Treating: {g} g at {time}', { g: tr.grams, time: clock(tr.t) })) + '</h2><p>' + esc(left ? t('Recheck at {time}, in {n} min.', { time: clock(tr.recheckAt), n: left }) : t('Time to recheck.')) + (tr.by ? ' <span class="muted">' + esc(t('Logged on {who}.', { who: tr.by })) + '</span>' : '') + '</p><p class="note">' + t('su94r tells you at the recheck where it went. Still low, the reminders start again.') + '</p>');
    } else if ((lowNow || (ep && !ep.acked)) && S.me && S.me.canLog) {
      const g = S.treatGrams || plan.grams;
      html += card('<h2>' + t('Treat the low') + '</h2>' + (plan.text ? '<p>' + esc(t('Your plan: {plan}', { plan: plan.text })) + '</p>' : '') +
        '<div class="quick" style="justify-content:flex-start">' + [10, 15, 20, 30].concat([10, 15, 20, 30].indexOf(plan.grams) < 0 ? [plan.grams] : []).sort((a, b) => a - b).map((x) => '<button data-treat-g="' + x + '"' + (x === g ? ' style="background:var(--fg);color:var(--bg);border-color:var(--fg)"' : '') + '>' + x + ' g</button>').join('') + '</div>' +
        '<button class="btn wide" id="treatBtn" data-g="' + g + '">' + esc(t('I treated it with {g} g', { g })) + '</button><p class="note">' + esc(t('Logs the carbs, stops the reminders, and rechecks in {n} min.', { n: plan.minutes })) + '</p>');
    }
    let top = '<div class="big state-' + state + '"><span class="v">' + (l ? fmt(l.mg, units) : '—') + '</span>' +
      (l && !stale ? '<span class="a" aria-label="' + esc(ARROW_WORD()[l.trend] || '') + '">' + (ARROW[l.trend] || '') + '</span>' : '') + '<span class="u">' + esc(units) + '</span></div>';
    top += '<div class="sub">' + (people().length > 1 || (c.info && c.info.name) ? esc(c.info ? c.info.name : '') + ' · ' : '') +
      (l ? (delta != null ? esc(t('{d} in 15 min · ', { d: fmtDelta(delta, units) })) : '') + esc(ago(l.t)) : t('no reading yet')) + '</div>';
    if (l && !stale && l.mg < L.low) top += '<div class="banner low">' + esc(t('{what}: below {v} {u}', { what: t(l.mg < 55 ? 'Urgent low' : 'Low'), v: fmt(L.low, units), u: units })) + '</div>';
    if (stale && l) top += '<div class="banner stale">' + esc(t('No new reading for {t}. The sensor or the phone running LibreLink may be out of range.', { t: ago(l.t).replace(' ago', '').replace('hace ', '') })) + '</div>';
    top += '<div class="segm" role="group" aria-label="' + t('Hours shown') + '" style="margin-top:14px">' + [3, 6, 12].map((hh) => '<button data-range="' + hh + '" aria-pressed="' + (S.range === hh) + '">' + hh + ' h</button>').join('') + '</div>';
    top += chart({ pts: hist, from, to, low: L.low, high: L.high, units, events, est, last: l, label: t('Glucose for the last {n} hours', { n: S.range }) }) + legend();
    html += card(top);
    if (est && (est.h30 || est.h60)) {
      const part = (q, when) => (q ? t('<b>{when}</b>: about {v} ({lo}–{hi})', { when, v: fmt(q.mg, units), lo: fmt(q.lo, units), hi: fmt(q.hi, units) }) : '');
      html += card('<h2>' + t('Where it may head') + '</h2><div class="est">' + [part(est.h30, t('In 30 min')), part(est.h60, t('In 1 hour'))].filter(Boolean).join(' · ') + '</div>' +
        '<p class="note">' + esc(t('An estimate from su94r Mini\'s learner, made {ago} from your own past data. Not a reason to dose.', { ago: ago(est.at) })) + '</p>');
    }
    if (L.sensorStart) {
      const ends = L.sensorStart + ((S.recent && S.recent.sensorDays) || 14) * DAY;
      const left = ends - now;
      const when = left <= 0 ? t('Sensor has ended')
        : left < DAY && dateKey(ends) === dateKey(now) ? t('Sensor ends today at {time}', { time: clock(ends) })
          : left < 2 * DAY ? t('Sensor ends tomorrow at {time}', { time: clock(ends) })
            : t('Sensor ends in {n} days ({date})', { n: Math.floor(left / DAY), date: new Date(ends).toLocaleDateString(LOC(), { weekday: 'short', month: 'short', day: 'numeric' }) });
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
  const rangeBar = (s) => '<div class="bar" aria-label="' + pct(s.inr) + ' ' + t('in range') + '">' + [['b-vl', s.vl], ['b-l', s.lo], ['b-in', s.inr], ['b-h', s.hi], ['b-vh', s.vh]].map((a) => '<span class="' + a[0] + '" style="width:' + (a[1] * 100).toFixed(1) + '%"></span>').join('') + '</div>';
  const kv = (pairs) => '<div class="kv">' + pairs.map((p) => '<div><b>' + p[0] + '</b><span>' + p[1] + '</span></div>').join('') + '</div>';

  async function renderHistory() {
    const c = cur();
    const days = S.days;
    let html = '<div class="segm" role="group" aria-label="' + t('Days shown') + '" style="margin-bottom:12px">' + [1, 7, 14, 30, 90].map((d) => '<button data-days="' + d + '" aria-pressed="' + (days === d) + '">' + (d === 1 ? t('1 day') : t('{n} d', { n: d })) + '</button>').join('') + '</div>';
    const cached = S.hist[days];
    if (!cached || Date.now() - cached.at > 5 * MIN) {
      main(html + card('<p class="muted">' + (days === 1 ? t('Loading 1 day of readings…') : t('Loading {n} days of readings…', { n: days })) + '</p>'));
      try { S.hist[days] = { at: Date.now(), data: await api('app/history?days=' + days) }; } catch (e) { main(html + card('<p>' + esc(e.message) + '</p>')); return; }
      if (S.tab !== 'history' || S.days !== days) return;
    }
    const info = c.info || {};
    const low = info.low || 70, high = info.high || 180, units = info.units || 'mg/dL';
    const pts = (S.hist[days].data.points[c.pid] || []);
    const now = Date.now();
    if (!pts.length) { main(html + card('<p class="muted">' + t('The server has no readings for this period yet. It saves every reading from now on, and su94r Mini on your computer copies its own history once.') + '</p>')); return; }
    const events = S.recent ? S.recent.events.filter((e) => !c.pid || e.p === c.pid) : [];
    if (S.dayView) {
      const start = new Date(S.dayView); start.setHours(0, 0, 0, 0);
      const end = Math.min(now, start.getTime() + DAY);
      const dp = pts.filter((p) => p[0] >= start.getTime() && p[0] < end);
      const s = stats(dp, low, high);
      html += card('<div class="row"><button class="btn ghost" data-back="1">' + t('‹ Back') + '</button><h2 style="margin:0">' + esc(dayLabel(start.getTime())) + '</h2></div>' +
        (s ? kv([[pct(s.inr), t('in range')], [fmt(s.mean, units), t('average')], [fmt(s.min, units), t('lowest')], [fmt(s.max, units), t('highest')]]) : '') +
        chart({ pts: dp, from: start.getTime(), to: start.getTime() + DAY, low, high, units, events, label: t('Glucose on {day}', { day: dayLabel(start.getTime()) }) }) + legend());
      main(html);
      return;
    }
    const from = now - days * DAY;
    const s = stats(pts, low, high);
    const coverage = Math.min(1, s.slots / (days * 96));
    html += card(kv([[pct(s.inr), t('in range')], [fmt(s.mean, units), t('average')], [s.gmi.toFixed(1) + '%', t('GMI')], [s.lows, t('lows')]]) +
      '<div style="margin-top:12px">' + rangeBar(s) + '</div>' +
      '<p class="muted small" style="margin:6px 0 0">' + esc(t('{b} below · {a} above · readings for {c} of the time', { b: pct(s.vl + s.lo), a: pct(s.hi + s.vh), c: pct(coverage) })) + '</p>' +
      chart({ pts, from, to: now, low, high, units, events: days <= 2 ? events : [], label: t('Glucose for the last {n} days', { n: days }) }) +
      (coverage < 0.7 ? '<p class="note">' + esc(t('The server has readings from {day}. Each day fills in more; su94r Mini on your computer also copies the history it has kept.', { day: dayLabel(pts[0][0]) })) + '</p>' : ''));
    if (days >= 7) {
      const pr = S.patterns && S.patterns.pid === c.pid && S.patterns.lang === S.lang && Date.now() - S.patterns.at < 10 * MIN ? S.patterns : null;
      if (pr) html += card('<h2>' + t('Patterns') + '</h2>' + (pr.data.patterns.length ? '<ul class="pat">' + pr.data.patterns.map((p) => '<li>' + esc(p.text) + '</li>').join('') + '</ul><p class="note">' + t('From the last 14 days. It describes what repeated; it does not advise.') + '</p>' : '<p class="muted">' + esc(pr.data.note || t('No clear patterns yet.')) + '</p>'));
      else { const lang = S.lang; api('app/patterns?pid=' + encodeURIComponent(c.pid)).then((data) => { S.patterns = { pid: c.pid, lang, at: Date.now(), data }; if (S.tab === 'history' && !S.dayView) renderHistory(); }).catch(() => {}); }
    }
    if (days > 1) {
      const byDay = new Map();
      pts.forEach((p) => { const k = dateKey(p[0]); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(p); });
      const rows = Array.from(byDay.entries()).reverse().map((e) => {
        const ds = stats(e[1], low, high);
        return '<li><button data-day="' + esc(e[0]) + '">' + esc(dayLabel(e[1][0][0])) + '</button>' + rangeBar(ds) + '<span class="muted">' + pct(ds.inr) + ' · ' + fmt(ds.mean, units) + '</span></li>';
      }).join('');
      html += card('<h2>' + t('Day by day') + '</h2><ul class="days">' + rows + '</ul><p class="note">' + t('Tap a day to see it.') + '</p>');
    }
    main(html);
  }

  // ---------- Log ----------
  function recentList(editable) {
    const c = cur();
    const ev = S.recent ? S.recent.events.filter((e) => !c.pid || e.p === c.pid).sort((a, b) => b.t - a.t) : [];
    if (!ev.length) return '<p class="muted">' + t('Nothing logged in the last 48 hours.') + '</p>';
    const src = SOURCE();
    return '<ul class="list">' + ev.slice(0, 30).map((e) => '<li><span class="t">' + esc(dateKey(e.t) === dateKey(Date.now()) ? clock(e.t) : dayLabel(e.t) + ' ' + clock(e.t)) + '</span><span>' + esc(short(e)) + '</span>' +
      '<span class="src">' + esc((src[e.source] || e.source || '') + (e.by ? ' · ' + e.by : '')) + '</span>' + (editable && e.mine ? '<button data-undo="' + esc(e.id) + '">' + t('Undo') + '</button>' : '') + '</li>').join('') + '</ul>';
  }
  function renderLog() {
    const canLog = S.me && S.me.canLog;
    if (!canLog) {
      main(card('<h2>' + t('Logging') + '</h2><p>' + t('This phone shows the glucose and the history. It can\'t log yet: the owner can allow it in su94r Mini (Share to another phone) or in their own su94r app (More).') + '</p>') +
        card('<h2>' + t('Last 48 hours') + '</h2>' + recentList(false)));
      return;
    }
    const L = S.log, carbs = L.kind === 'carbs';
    const kindBtn = (k, label) => '<button data-kind="' + k + '" aria-pressed="' + (L.kind === k) + '">' + label + '</button>';
    const quick = carbs ? [10, 15, 20, 30, 45, 60, 75, 90] : [1, 2, 3, 4, 5, 6, 8, 10];
    const whens = [[0, t('Now')], [15, t('15 min ago')], [30, t('30 min ago')], [60, t('1 h ago')], [120, t('2 h ago')]];
    let m = '';
    if (carbs) {
      m = '<div class="photo"><label class="btn ghost" style="display:block">' + t('📷 Estimate from a photo') + '<input type="file" accept="image/*" capture="environment" id="photo"></label></div>';
      if (L.meal && L.meal.busy) m += '<div class="meal">' + t('Looking at the photo…') + '</div>';
      else if (L.meal && L.meal.error) m += '<div class="meal">' + esc(L.meal.error) + '</div>';
      else if (L.meal && L.meal.food) m += '<div class="meal">' + t('About <b>{g} g</b> of carbs (likely {lo}–{hi} g, {conf} confidence)', { g: L.meal.total, lo: L.meal.low, hi: L.meal.high, conf: esc(S.lang === 'es' ? ({ low: 'baja', medium: 'media', high: 'alta' })[L.meal.confidence] || L.meal.confidence : L.meal.confidence) }) +
        (L.meal.items.length ? ': ' + L.meal.items.map((x) => esc(x.name) + (x.carbs != null ? ' ' + esc(t('about {g} g', { g: x.carbs })) : '')).join(', ') : '') + '.<br><span class="muted small">' + t('Photo estimates are rough: check the number before logging.') + '</span></div>';
    }
    const mic = (window.SpeechRecognition || window.webkitSpeechRecognition) ? '<button class="btn ghost" id="micBtn" style="display:block;width:100%;margin-bottom:12px">' + esc(t('🎤 Say it: "4 units rapid" or "40 grams"')) + '</button>' + (S.heard ? '<p class="note" style="margin-top:-6px">' + esc(S.heard) + '</p>' : '') : '';
    const html = card('<h2>' + t('Log') + '</h2>' + mic + '<div class="kinds">' + kindBtn('rapid', t('Rapid insulin')) + kindBtn('basal', t('Long-acting')) + kindBtn('carbs', t('Carbs')) + '</div>' + m +
      '<div class="row" style="margin-top:10px"><label class="muted small" for="otherKind">' + t('Other insulin') + '</label><select id="otherKind"><option value="">—</option>' +
      [['short', t('Regular')], ['intermediate', 'NPH'], ['mix', t('Pre-mixed')]].map((o) => '<option value="' + o[0] + '"' + (L.kind === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<div class="amount"><button data-step="-1" aria-label="' + t('Less') + '">−</button><output id="amt" aria-live="polite">' + (L.amount || 0) + '<small>' + (carbs ? t('grams') : t('units')) + '</small></output><button data-step="1" aria-label="' + t('More') + '">+</button></div>' +
      '<div class="quick">' + quick.map((q) => '<button data-amount="' + q + '">' + q + (carbs ? ' g' : ' u') + '</button>').join('') + '</div>' +
      '<div class="muted small">' + t('When') + '</div><div class="when">' + whens.map((w) => '<button data-ago="' + w[0] + '" aria-pressed="' + (L.ago === w[0]) + '">' + w[1] + '</button>').join('') + '</div>' +
      '<button class="btn wide" id="logBtn"' + (L.amount > 0 ? '' : ' disabled') + '>' + esc(L.amount > 0 ? t('Log {what}', { what: what(L.kind, L.amount) }) : t('Choose an amount')) + '</button>' +
      '<p class="note">' + t('Logged doses reach su94r Mini, Alexa and the double-dose check. su94r never suggests a dose.') + '</p>');
    main(html + card('<h2>' + t('Last 48 hours') + '</h2>' + recentList(true)));
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
    const el = document.createElement('div');
    el.className = 'toast'; el.id = 'toast'; el.setAttribute('role', 'status');
    el.innerHTML = '<span>' + esc(text) + '</span>' + (action ? '<button>' + esc(action) + '</button>' : '');
    if (action) el.querySelector('button').onclick = () => { el.remove(); fn(); };
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), action ? 10000 : 4000);
  }
  // Log by voice: the phone's own speech recognition turns it into text; the server reads the
  // text the same way as a Telegram message (tglog.js, English or Spanish); nothing is saved
  // before "Log it".
  function listen(btn) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = S.lang === 'es' ? 'es-US' : 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    btn.disabled = true; btn.textContent = t('🎤 Listening…');
    rec.onerror = (e) => { S.heard = e.error === 'not-allowed' ? t('The microphone is blocked for su94r. Allow it in the browser settings.') : t('Did not catch that. Try again.'); renderLog(); };
    rec.onend = () => { if (btn.isConnected) { btn.disabled = false; btn.textContent = t('🎤 Say it: "4 units rapid" or "40 grams"'); } };
    rec.onresult = async (e) => {
      const alts = Array.from(e.results[0] || []).map((a) => a.transcript);
      let r = null;
      for (const text of alts) {
        try { r = await api('app/parse', { method: 'POST', body: { text } }); } catch (x) { r = { ok: false, error: x.message }; }
        if (r.ok) break;
      }
      if (!r || !r.ok) { S.heard = t('Heard "{t}".', { t: alts[0] || '' }) + ' ' + ((r && r.error) || ''); renderLog(); return; }
      S.heard = t('Heard "{t}".', { t: r.heard });
      S.log.kind = r.kind; S.log.amount = r.amount; S.log.ago = r.minutesAgo || 0; S.log.meal = null;
      renderLog();
      askToLog();
    };
    try { rec.start(); } catch (x) { btn.disabled = false; }
  }

  function askToLog() {
    const L = S.log, c = cur();
    const when = L.ago ? t('{m} min ago', { m: L.ago }) : t('now');
    sheet('<h3>' + esc(t('Log {what}, {when}?', { what: what(L.kind, L.amount), when })) + '</h3>' + (c.info && c.info.name ? '<p class="muted">' + esc(t('For {name}.', { name: c.info.name })) + '</p>' : ''),
      [[t('Log it'), 'btn', () => send(false)], [t('Cancel'), 'btn ghost', closeSheet]]);
  }
  async function send(confirm) {
    const L = S.log, c = cur();
    document.querySelectorAll('#sheet button').forEach((b) => { b.disabled = true; });
    let r;
    try { r = await api('app/log', { method: 'POST', body: { kind: L.kind, amount: L.amount, minutesAgo: L.ago, pid: c.pid, confirm } }); }
    catch (e) { sheet('<h3>' + t('Not logged') + '</h3><p>' + esc(e.message) + '</p>', [[t('Close'), 'btn ghost', closeSheet]]); return; }
    if (r.confirm) {
      sheet('<h3>' + esc(t('Log {what} anyway?', { what: what(L.kind, L.amount) })) + '</h3><div class="warnbox">' + esc(r.warning) + '</div><p class="muted small">' + t('Check before logging a second dose.') + '</p>',
        [[t('Log anyway'), 'btn warn', () => send(true)], [t('Cancel'), 'btn ghost', closeSheet]]);
      return;
    }
    closeSheet();
    S.log.amount = 0; S.log.meal = null;
    toast(r.text, t('Undo'), () => undo(r.id));
    await refreshRecent();
    if (S.tab === 'log') renderLog();
  }
  async function undo(id) {
    try { await api('app/undo', { method: 'POST', body: { id } }); toast(t('Removed.')); }
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
      img.onerror = () => { URL.revokeObjectURL(url); no(new Error(t('This phone could not open that photo.'))); };
      img.src = url;
    });
  }
  async function photo(file) {
    S.log.meal = { busy: true }; renderLog();
    try {
      const image = await shrink(file, 1024);
      const res = await fetch('/app/meal', { method: 'POST', cache: 'no-store', headers: { Authorization: 'Bearer ' + store.get(K.token), 'Content-Type': 'application/json', 'X-Su94r-Lang': S.lang }, body: JSON.stringify({ image }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || t('The photo check answered {s}.', { s: res.status }));
      const m = j.meal;
      if (!m) throw new Error(t('Could not read that photo. Type the grams instead.'));
      if (!m.food) throw new Error(t('No food seen in that photo. Type the grams instead.'));
      S.log.meal = m; S.log.amount = m.total;
    } catch (e) { S.log.meal = { error: e.message }; }
    if (S.tab === 'log') renderLog();
  }

  // ---------- low alerts in this app (web push) ----------
  async function swReady() {
    return Promise.race([navigator.serviceWorker.ready, new Promise((ok, no) => setTimeout(() => no(new Error(t('The app is still installing its helper. Try again in a moment.'))), 8000))]);
  }
  async function pushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try { const reg = await swReady(); return (await reg.pushManager.getSubscription()) && Notification.permission === 'granted' ? 'on' : 'off'; } catch (e) { return 'off'; }
  }
  async function pushOn() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(t('Notifications were not allowed. Allow them for su94r in the phone\'s settings, then try again.'));
    const { key } = await api('app/push/key');
    const reg = await swReady();
    let sub = await reg.pushManager.getSubscription();
    const opts = { userVisibleOnly: true, applicationServerKey: fromB64u(key) };
    try { if (!sub) sub = await reg.pushManager.subscribe(opts); }
    catch (e) { if (sub) await sub.unsubscribe(); sub = await reg.pushManager.subscribe(opts); }
    const j = sub.toJSON();
    await api('app/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys, lang: S.lang } });
  }
  async function pushOff() {
    const reg = await swReady();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api('app/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }

  // ---------- supplies ----------
  const SUPPLY = () => [['rapid', t('Rapid insulin')], ['basal', t('Long-acting insulin')], ['short', t('Regular insulin')], ['intermediate', t('NPH insulin')], ['mix', t('Pre-mixed insulin')], ['sensors', t('Sensors')]];
  const supplyLabel = (item) => (SUPPLY().find((o) => o[0] === item) || [item, item])[1];
  function editSupply(item) {
    const s = (S.supplies || []).find((x) => x.item === item) || null;
    const free = SUPPLY().filter((o) => !(S.supplies || []).some((x) => x.item === o[0]));
    sheet('<h3>' + esc(s ? supplyLabel(s.item) : t('Add supplies')) + '</h3>' +
      (s ? '' : '<label for="supItem">' + t('What') + '</label><select id="supItem">' + free.map((o) => '<option value="' + o[0] + '">' + o[1] + '</option>').join('') + '</select>') +
      '<label for="supHave">' + t('On hand now (units of insulin, or sensors)') + '</label><input id="supHave" type="number" inputmode="decimal" min="0" value="' + (s ? s.left : '') + '">' +
      '<p class="note" style="margin-top:-4px">' + t('A U-100 pen holds 300 units; a 10 mL vial 1000.') + '</p>' +
      '<label for="supWarn">' + t('Remind me when it is down to') + '</label><input id="supWarn" type="number" inputmode="decimal" min="0" placeholder="' + esc(t('for example 300 units, or 1 sensor')) + '" value="' + (s && s.warnAt ? s.warnAt : '') + '">' +
      '<label for="supRefill">' + t('Refill date (optional)') + '</label><input id="supRefill" type="date" value="' + (s && s.refillOn ? esc(s.refillOn) : '') + '">',
      [[t('Save'), 'btn', () => saveSupply(s ? s.item : null)]].concat(s ? [[t('Remove'), 'btn ghost', () => removeSupply(s.item)]] : []).concat([[t('Cancel'), 'btn ghost', closeSheet]]));
  }
  async function saveSupply(item) {
    const body = { pid: cur().pid, item: item || $('supItem').value, onHand: $('supHave').value, warnAt: $('supWarn').value, refillOn: $('supRefill').value || null };
    try { await api('app/supplies/save', { method: 'POST', body }); closeSheet(); toast(t('Saved.')); }
    catch (e) { toast(e.message); return; }
    if (S.tab === 'more') renderMore();
  }
  async function removeSupply(item) {
    try { await api('app/supplies/remove', { method: 'POST', body: { pid: cur().pid, item } }); closeSheet(); toast(t('Removed.')); }
    catch (e) { toast(e.message); return; }
    if (S.tab === 'more') renderMore();
  }

  // ---------- treating a low ----------
  function askToTreat(grams) {
    const plan = (S.recent && S.recent.plan) || { minutes: 15 };
    sheet('<h3>' + esc(t('Log {g} g to treat the low?', { g: grams })) + '</h3><p class="muted">' + esc(t('The reminders stop, and su94r rechecks in {n} minutes.', { n: plan.minutes })) + '</p>',
      [[t('Log it'), 'btn', async () => {
        document.querySelectorAll('#sheet button').forEach((b) => { b.disabled = true; });
        try {
          const r = await api('app/treat', { method: 'POST', body: { grams, pid: cur().pid } });
          closeSheet(); S.treatGrams = null; S.pendingAck = null;
          toast(r.text, t('Undo'), () => undo(r.id));
        } catch (e) { sheet('<h3>' + t('Not logged') + '</h3><p>' + esc(e.message) + '</p>', [[t('Close'), 'btn ghost', closeSheet]]); return; }
        await refreshRecent();
      }], [t('Cancel'), 'btn ghost', closeSheet]]);
  }
  async function sendAck() {
    const a = S.pendingAck; if (!a) return;
    try {
      const r = await fetch(a, { method: 'POST', cache: 'no-store' });
      toast(r.ok ? t('Got it. Reminders for this low stop.') : t('That alert was already answered.'));
    } catch (e) { toast(t('Could not reach the server. Try again.')); return; }
    S.pendingAck = null;
    renderNow();
  }

  // ---------- Report ----------
  async function renderReport() {
    const c = cur();
    const key = c.pid + ':' + S.lang;
    const r = S.report[key];
    if (!r || Date.now() - r.at > 10 * MIN) {
      main(card('<p class="muted">' + t('Making the 14-day report…') + '</p>'));
      try { S.report[key] = { at: Date.now(), data: await api('app/report?pid=' + encodeURIComponent(c.pid)) }; } catch (e) { main(card('<p>' + esc(e.message) + '</p>')); return; }
      if (S.tab !== 'report') return;
    }
    main('<div class="row noprint" style="margin-bottom:12px"><button class="btn ghost" id="print">' + t('Print or save as PDF') + '</button></div>' +
      card(reportHtml(S.report[key].data, S.lang), 'report') +
      '<p class="note noprint">' + t('For your doctor: su94r Mini → Health vault → <b>Live link for my doctor</b> makes a private link that always shows this report.') + '</p>');
    let labs = null;
    try { labs = await api('app/labs?pid=' + encodeURIComponent(c.pid)); } catch (e) { labs = null; }
    if (S.tab !== 'report' || !labs) return;
    $('main').insertAdjacentHTML('beforeend', card('<h2>' + t('Lab results') + '</h2>' + (labs.labs.length ? '<ul class="list">' + labs.labs.map((l) => '<li><span class="t">' + esc(l.takenOn) + '</span><span>' + esc(l.name) + ' <b>' + esc(String(l.value)) + (l.unit ? ' ' + esc(l.unit) : '') + '</b></span>' + (labs.canEdit ? '<button data-lab-del="' + esc(l.id) + '" style="margin-left:auto">' + t('Remove') + '</button>' : '') + '</li>').join('') + '</ul>' : '<p class="muted">' + t('None yet. An A1c typed in here shows in the report and the doctor\'s link next to the GMI.') + '</p>') +
      (labs.canEdit ? '<button class="btn ghost" id="labAdd">' + t('Add a lab result') + '</button>' : ''), 'noprint'));
  }

  function editLab() {
    const today = new Date(); const iso = new Date(today.getTime() - today.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
    sheet('<h3>' + t('Add a lab result') + '</h3><label for="labKind">' + t('Test') + '</label><select id="labKind"><option value="a1c">A1c (%)</option><option value="other">' + t('Another test') + '</option></select>' +
      '<div id="labOther" hidden><label for="labName">' + t('Name') + '</label><input id="labName" maxlength="40" placeholder="' + esc(t('for example LDL cholesterol')) + '"><label for="labUnit">' + t('Unit') + '</label><input id="labUnit" maxlength="16" placeholder="' + esc(t('for example mg/dL')) + '"></div>' +
      '<label for="labValue">' + t('Result') + '</label><input id="labValue" type="number" inputmode="decimal" step="any"><label for="labDate">' + t('Date of the test') + '</label><input id="labDate" type="date" value="' + iso + '">',
      [[t('Save'), 'btn', saveLab], [t('Cancel'), 'btn ghost', closeSheet]]);
    $('labKind').onchange = () => { $('labOther').hidden = $('labKind').value !== 'other'; };
  }
  async function saveLab() {
    const body = { pid: cur().pid, kind: $('labKind').value, name: $('labName').value, unit: $('labUnit').value, value: $('labValue').value, takenOn: $('labDate').value };
    try { await api('app/labs/save', { method: 'POST', body }); closeSheet(); toast(t('Saved. It shows in the report.')); }
    catch (e) { toast(e.message); return; }
    S.report = {};
    if (S.tab === 'report') renderReport();
  }
  async function removeLab(id) {
    try { await api('app/labs/remove', { method: 'POST', body: { pid: cur().pid, id } }); toast(t('Removed.')); }
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
    const copy = (v) => ' <button class="btn ghost" style="padding:4px 10px" data-copy="' + esc(v) + '">' + t('Copy') + '</button>';
    const install = standalone ? '<p>' + t('Installed. Open su94r from the home screen.') + '</p>'
      : S.installEvt ? '<p>' + t('Put su94r on the home screen like any app.') + '</p><button class="btn" id="install">' + t('Install su94r') + '</button>'
        : ios ? '<p>' + t('In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>.') + '</p>' : '<p>' + t('In Chrome tap <b>⋮</b>, then <b>Install app</b> or <b>Add to Home screen</b>.') + '</p>';
    let html = '';
    if (S.justLinked) html += '<div class="banner stale" style="margin:0 0 12px">' + t('This phone is linked. Turn on its low alerts below, and install the app.') + '</div>';
    const ps = await pushState();
    if (S.tab !== 'more') return;
    let pc = '<h2>' + t('Low alerts in this app') + '</h2>';
    if (ps === 'unsupported') pc += '<p>' + (ios && !standalone ? t('On iPhone, install the app first (Safari: Share → <b>Add to Home Screen</b>), open it from the home screen, then turn alerts on here.') : t('This browser cannot show alerts from the app. Use ntfy or Telegram below.')) + '</p>';
    else if (ps === 'denied') pc += '<p>' + t('Notifications are blocked for su94r on this phone. Allow them in the phone\'s settings, then come back here.') + '</p>';
    else if (ps === 'on') pc += '<p>' + t('On.') + ' ' + (role === 'family' ? t('This phone rings when a low is not handled (once the owner switches on “Tell caregivers too”).') : t('This phone rings for every low until “I\'m OK”, for Low soon and for sensor warnings.')) + '</p><div class="row"><button class="btn ghost" id="pushTest">' + t('Send a test') + '</button><button class="btn ghost" id="pushOff">' + t('Turn off') + '</button></div>';
    else pc += '<p>' + (role === 'family' ? t('Ring this phone when a low is not handled.') : t('Ring this phone for lows, with an “I\'m OK” button. No other app needed.')) + '</p><button class="btn" id="pushOn">' + t('Ring for lows on this phone') + '</button>';
    pc += '<p class="note">' + t('Your phone\'s silent and Do Not Disturb settings still apply; for nights, let su94r (or Chrome) through.') + '</p>';
    html += card(pc);
    html += card('<h2>' + t('Language') + '</h2><div class="segm" role="group" aria-label="' + t('Language') + '"><button data-lang="en" aria-pressed="' + (S.lang === 'en') + '">English</button><button data-lang="es" aria-pressed="' + (S.lang === 'es') + '">Español</button></div>');
    html += card('<h2>' + t('Install') + '</h2>' + install);
    if (!S.extras) { try { S.extras = await api('share/extras'); } catch (e) { S.extras = {}; } }
    const x = S.extras || {}, a = x.alerts;
    let alerts = '<h2>' + t('Also on ntfy or Telegram') + '</h2>';
    if (a) {
      alerts += '<p>' + (a.role === 'family' ? t('You are told when a low is not handled.') + (a.on ? '' : t(' The owner has not switched family alerts on yet.')) : t('The same alerts as the owner: every low, repeated until “I\'m OK”.')) + t(' The same alerts can also come through <b>ntfy</b> (free) or Telegram.') + '</p>' +
        '<p><a class="btn" href="ntfy://' + esc(a.url.replace(/^https?:\/\//, '')) + '">' + t('Subscribe in ntfy') + '</a> <a class="btn ghost" href="' + esc(a.url) + '">' + t('Open in the browser') + '</a></p>' +
        '<p class="muted small">' + t('Get ntfy:') + ' <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy">Play Store</a> · <a href="https://apps.apple.com/app/ntfy/id1625396347">App Store</a>. ' + t('Or in ntfy tap + and paste') + ' <code>' + esc(a.topic) + '</code>' + copy(a.topic) + '</p>';
    } else alerts += '<p class="muted">' + t('Low alerts are not set up on the server yet: su94r Mini → Health vault → Low alerts.') + '</p>';
    if (x.telegram) alerts += '<p>' + t('Prefer Telegram? <a class="btn ghost" href="{url}">Open in Telegram</a> then press <b>Start</b>. The link works once, for 15 minutes.', { url: esc(x.telegram) }) + '</p>';
    html += card(alerts);
    if (ns) html += card('<h2>' + t('Watch and widgets') + '</h2><p>' + t('In <b>GlucoDataHandler</b> (free, also on the Pixel Watch): Sources → Nightscout, with this address and token.') + '</p><p class="small"><code>' + esc(base) + '/ns</code>' + copy(base + '/ns') + '</p><p class="small"><code>' + esc(ns) + '</code>' + copy(ns) + '</p>');
    if (role === 'me') {
      let phones = null;
      try { phones = (await api('app/phones')).phones; } catch (e) { /* shown below */ }
      if (S.tab !== 'more') return;
      html += card('<h2>' + t('Family phones') + '</h2>' + (phones == null ? '<p class="muted">' + t('Could not load the family phones.') + '</p>'
        : !phones.length ? '<p class="muted">' + t('No family phones linked yet. Make a family code in su94r Mini → Share to another phone.') + '</p>'
          : '<p class="muted small">' + t('A family member who lives with you can log doses and meals too. Their doses get the same double-dose check.') + '</p><ul class="list">' +
            phones.map((p) => '<li><span>' + esc(p.name) + '</span><span class="src">' + t(p.canLog ? 'can log' : 'reads only') + '</span><button data-allow="' + esc(p.id) + '" data-on="' + (p.canLog ? '0' : '1') + '">' + t(p.canLog ? 'Stop logging' : 'Allow logging') + '</button></li>').join('') + '</ul>'));
    }
    let sup = null;
    try { sup = await api('app/supplies?pid=' + encodeURIComponent(cur().pid)); } catch (e) { sup = null; }
    if (S.tab !== 'more') return;
    if (sup) {
      const items = sup.items || [];
      S.supplies = items;
      html += card('<h2>' + t('Supplies') + '</h2>' + (items.length ? '<ul class="list">' + items.map((s) => '<li><span>' + esc(supplyLabel(s.item)) + '</span><span class="src" style="' + (s.low || s.refillDue ? 'color:var(--h);font-weight:600' : '') + '">' + esc(t('{n} {u} left', { n: s.left, u: s.item === 'sensors' ? t('sensors') : t('units') })) + (s.daysLeft != null ? ' · ~' + s.daysLeft + ' d' : '') + (s.refillOn ? ' · ' + esc(t('refill {date}', { date: s.refillOn })) : '') + '</span>' + (sup.canEdit ? '<button data-supply="' + esc(s.item) + '">' + t('Edit') + '</button>' : '') + '</li>').join('') + '</ul>' : '<p class="muted">' + t('Nothing tracked yet.') + '</p>') +
        (sup.canEdit && items.length < 6 ? '<button class="btn ghost" data-supply="">' + t('Add insulin or sensors') + '</button>' : '') +
        '<p class="note">' + t('Counts down as doses are logged (pen priming is not counted) and as new sensors start. su94r reminds you by day when it runs low or a refill is due.') + '</p>');
    }
    html += card('<h2>' + t('This phone') + '</h2><p>' + (role === 'family' ? (S.me && S.me.canLog ? t('A family member\'s phone: it reads and logs (the owner allowed it).') : t('A family member\'s phone: it reads; the owner can allow it to log.')) : t('Your own phone: it reads and logs.')) + (S.me && S.me.name ? esc(t(' Named “{name}” in su94r Mini.', { name: S.me.name })) : '') + '</p>' +
      '<button class="btn ghost" id="unlink">' + t('Unlink this phone') + '</button>');
    html += '<p class="note" style="text-align:center">' + t('su94r · not a medical device. Readings come from LibreLinkUp and can be a few minutes behind.') + '</p>';
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
  /** Switches this phone's language; the server's words follow on the next request. */
  function setLang(lang) {
    if (lang !== 'en' && lang !== 'es') return;
    S.lang = lang; store.set(K.lang, lang);
    S.patterns = null; S.heard = '';
    chrome(); status();
    if (store.get(K.token)) {
      // App alerts in the same language (the server keeps it with this phone's subscription).
      pushState().then((ps) => { if (ps === 'on') pushOn().catch(() => {}); });
      show(S.tab);
    } else welcome();
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); });
  $('people').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pid]'); if (!b) return;
    S.pid = b.dataset.pid; store.set(K.pid, S.pid); S.dayView = null;
    renderPeople(); show(S.tab);
  });
  $('main').addEventListener('click', (e) => {
    const el = e.target.closest('button,a'); if (!el) return;
    const d = el.dataset;
    if (d.lang) setLang(d.lang);
    else if (d.range) { S.range = Number(d.range); store.set(K.range, d.range); renderNow(); }
    else if (d.days) { S.days = Number(d.days); store.set(K.days, d.days); S.dayView = null; renderHistory(); }
    else if (d.day) { S.dayView = d.day; renderHistory(); }
    else if (d.back) { S.dayView = null; renderHistory(); }
    else if (d.kind) { S.log.kind = d.kind; S.log.amount = 0; S.log.meal = null; renderLog(); }
    else if (d.step) setAmount(S.log.amount + Number(d.step) * (S.log.kind === 'carbs' ? 5 : 0.5));
    else if (d.amount) setAmount(Number(d.amount));
    else if (d.ago !== undefined) { S.log.ago = Number(d.ago); renderLog(); }
    else if (el.id === 'logBtn') askToLog();
    else if (el.id === 'micBtn') listen(el);
    else if (el.id === 'labAdd') editLab();
    else if (d.labDel) removeLab(d.labDel);
    else if (d.undo) undo(d.undo);
    else if (d.supply !== undefined) editSupply(d.supply);
    else if (d.treatG) { S.treatGrams = Number(d.treatG); renderNow(); }
    else if (el.id === 'treatBtn') askToTreat(Number(d.g));
    else if (el.id === 'ackBtn') sendAck();
    else if (el.id === 'pushOn') { el.disabled = true; pushOn().then(() => toast(t('Alerts are on. Send a test to hear one.'))).catch((x) => toast(x.message)).then(() => { if (S.tab === 'more') renderMore(); }); }
    else if (el.id === 'pushOff') { el.disabled = true; pushOff().then(() => toast(t('App alerts are off on this phone.'))).catch((x) => toast(x.message)).then(() => { if (S.tab === 'more') renderMore(); }); }
    else if (el.id === 'pushTest') { el.disabled = true; api('app/push/test', { method: 'POST', body: {} }).then(() => toast(t('Test sent. It should ring in a few seconds.'))).catch((x) => toast(x.message)).then(() => { el.disabled = false; }); }
    else if (d.allow) {
      el.disabled = true;
      api('app/phones/allow', { method: 'POST', body: { id: d.allow, canLog: d.on === '1' } })
        .then(() => toast(t(d.on === '1' ? 'That phone can log now.' : 'That phone reads only now.')))
        .catch((x) => toast(x.message))
        .then(() => { if (S.tab === 'more') renderMore(); });
    }
    else if (el.id === 'print') window.print();
    else if (el.id === 'install' && S.installEvt) { S.installEvt.prompt(); S.installEvt = null; }
    else if (el.id === 'unlink') {
      sheet('<h3>' + t('Unlink this phone?') + '</h3><p>' + t('It stops showing the glucose here. To link it again, scan a new code from su94r Mini.') + '</p>',
        [[t('Unlink'), 'btn warn', () => { closeSheet(); [K.token, K.role, K.ns, K.last, K.me].forEach((k) => store.del(k)); welcome(); }], [t('Cancel'), 'btn ghost', closeSheet]]);
    } else if (d.copy && navigator.clipboard) navigator.clipboard.writeText(d.copy).then(() => { el.textContent = t('Copied'); }).catch(() => {});
  });
  $('main').addEventListener('change', (e) => {
    if (e.target.id === 'otherKind' && e.target.value) { S.log.kind = e.target.value; S.log.amount = 0; S.log.meal = null; renderLog(); }
    if (e.target.id === 'photo' && e.target.files && e.target.files[0]) photo(e.target.files[0]);
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.tab === 'more') renderMore(); });

  async function boot() {
    chrome();
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
