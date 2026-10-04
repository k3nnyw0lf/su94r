// "Can I drive?": the glucose now, where it is heading and the insulin still working, against the
// UK DVLA's guidance for drivers who use insulin (leaflet INF294, October 2025): do not drive at
// 4.0 mmol/L (72 mg/dL) or below; between 4.0 and 5.0 (72 to 90), eat fast-acting carbohydrate
// first; after a low, wait 45 minutes once back at 5.0 (90) or above; check at least every 2
// hours on the road. It describes the numbers and quotes that guidance; it is not a medical device.

const MIN = 60e3;

/**
 * { level: 'stop' | 'snack' | 'watch' | 'ok' | 'unknown', title, lines } for one person.
 *   latest { t, mg }, rate (mg/dL a minute or null), iob (units), soon (mg/dL in 30 minutes, the
 *   learner's trusted estimate, or null), fmt(mg) → "84 mg/dL".
 */
export function driveCheck({ latest, rate = null, iob = 0, soon = null, fmt = (mg) => `${Math.round(mg)} mg/dL`, now = Date.now(), lang = 'en' }) {
  const es = lang === 'es';
  const T = (en, sp) => (es ? sp : en);
  const source = T('From the UK DVLA guidance for drivers who use insulin (2025). Your own doctor\'s advice comes first. The sensor can run 5 to 15 minutes behind a meter.',
    'De la guía de la DVLA del Reino Unido para conductores que usan insulina (2025). El consejo de tu médico va primero. El sensor puede ir de 5 a 15 minutos atrás de un glucómetro.');
  if (!latest || now - latest.t > 15 * MIN) {
    return { level: 'unknown', title: T('No fresh reading', 'Sin lectura reciente'), lines: [T('Check with a meter before you drive.', 'Mide con un glucómetro antes de manejar.'), source] };
  }
  const mg = latest.mg;
  const lines = [];
  const projected = soon != null ? soon : rate != null ? mg + rate * 30 : null;
  if (iob >= 0.5) lines.push(T(`Active insulin about ${iob} u: it keeps lowering glucose for a few hours.`, `Insulina activa unas ${iob} u: sigue bajando la glucosa por unas horas.`));
  let level, title;
  if (mg <= 72) {
    level = 'stop';
    title = T(`${fmt(mg)}: don't drive`, `${fmt(mg)}: no manejes`);
    lines.unshift(T('Treat the low. Once you are back at 90 mg/dL (5.0 mmol/L) or above, wait 45 minutes before driving.', 'Trata la baja. Cuando vuelvas a 90 mg/dL (5.0 mmol/L) o más, espera 45 minutos antes de manejar.'));
  } else if (mg < 90) {
    level = 'snack';
    title = T(`${fmt(mg)}: eat first`, `${fmt(mg)}: come primero`);
    lines.unshift(T('Between 72 and 90 mg/dL: eat fast-acting carbohydrate (glucose tablets, a sugary drink) before you drive, then check again.', 'Entre 72 y 90 mg/dL: come carbohidrato rápido (tabletas de glucosa, una bebida azucarada) antes de manejar, y mide otra vez.'));
  } else if ((rate != null && rate <= -2) || (projected != null && projected < 90)) {
    level = 'watch';
    title = T(`${fmt(mg)} and falling`, `${fmt(mg)} y bajando`);
    lines.unshift(T(`Likely under 90 within half an hour${projected != null ? ` (about ${fmt(Math.max(40, projected))})` : ''}. Eat something first, keep fast sugar within reach, and check again before you set off.`, `Probablemente por debajo de 90 en media hora${projected != null ? ` (unos ${fmt(Math.max(40, projected))})` : ''}. Come algo primero, ten azúcar rápida a mano y mide otra vez antes de salir.`));
  } else {
    level = 'ok';
    title = T(`${fmt(mg)}: above 90`, `${fmt(mg)}: por encima de 90`);
    lines.unshift(T('Keep fast sugar in the car, and check at least every 2 hours on the road. If you feel low while driving, stop safely and treat it.', 'Ten azúcar rápida en el carro y mide al menos cada 2 horas en el camino. Si te sientes bajo mientras manejas, detente con seguridad y trátala.'));
  }
  lines.push(source);
  return { level, title, lines };
}
