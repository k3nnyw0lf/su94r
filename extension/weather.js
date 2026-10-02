// Heat: hourly outdoor temperature from Open-Meteo (free, no key, no sign-up) for the place set
// in Settings. Two uses: a hot-day note (insulin works faster in heat, and pens and vials lose
// strength above 86 °F / 30 °C), and the learner, which checks whether hot hours move your glucose.

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_HOSTS = ['https://geocoding-api.open-meteo.com/*', 'https://api.open-meteo.com/*'];

/** "Naples, FL" or a ZIP → { name, lat, lon, timezone } or null. */
export async function findPlace(query, { fetchImpl = fetch } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const name = q.split(',')[0].trim();
  const r = await fetchImpl(`${GEO}?${new URLSearchParams({ name, count: '5', language: 'en', format: 'json' })}`);
  if (!r.ok) throw new Error(`The weather service answered ${r.status}.`);
  const j = await r.json();
  const hint = q.split(',')[1]?.trim().toLowerCase();
  const pick = (j.results || []).find((x) => !hint || [x.admin1, x.admin1_code, x.country_code, x.country].some((v) => String(v || '').toLowerCase().startsWith(hint))) || j.results?.[0];
  return pick ? { name: [pick.name, pick.admin1, pick.country_code].filter(Boolean).join(', '), lat: pick.latitude, lon: pick.longitude, timezone: pick.timezone } : null;
}

/** Hourly temperatures (°C) for the past `pastDays` and next 2 days: [{ t, c }]. */
export async function hourlyTemps(place, { pastDays = 30, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ latitude: place.lat, longitude: place.lon, hourly: 'temperature_2m,apparent_temperature', past_days: String(Math.min(92, pastDays)), forecast_days: '2', timezone: 'UTC' });
  const r = await fetchImpl(`${FORECAST}?${params}`);
  if (!r.ok) throw new Error(`The weather service answered ${r.status}.`);
  const j = await r.json();
  const times = j.hourly?.time || [];
  return times.map((s, i) => ({ t: Date.parse(`${s}Z`), c: j.hourly.temperature_2m?.[i], feels: j.hourly.apparent_temperature?.[i] }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.c));
}

/** Today's (or the next 24 hours') hottest "feels like" temperature and when. */
export function hottest(temps, now = Date.now()) {
  const next = temps.filter((x) => x.t >= now - 3600e3 && x.t <= now + 24 * 3600e3);
  if (!next.length) return null;
  return next.reduce((a, b) => ((b.feels ?? b.c) > (a.feels ?? a.c) ? b : a));
}

/** A hot-day note, or null. 30 °C is 86 °F, the storage limit printed on insulin leaflets. */
export function heatNote(temps, { us = true, now = Date.now() } = {}) {
  const h = hottest(temps, now);
  if (!h || (h.feels ?? h.c) < 30) return null;
  const v = h.feels ?? h.c;
  const show = us ? `${Math.round((v * 9) / 5 + 32)} °F` : `${Math.round(v)} °C`;
  const at = new Date(h.t).toLocaleTimeString(undefined, { hour: 'numeric' });
  return {
    id: `heat|${new Date(h.t).toDateString()}`,
    text: `Hot today: feels like ${show} around ${at}. Insulin can work faster in the heat, and pens and vials in use should stay below 86 °F (not in a car or in the sun).`,
  };
}

/** Vault-style samples for the learner: one per hour, outdoor temperature in °C. */
export const tempSamples = (temps) => temps.map((x) => ({ type: 'outdoorTemp', t: x.t, end: x.t + 3600e3, value: x.c, src: 'open-meteo' }));
