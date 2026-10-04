// Carbs from a barcode, for the phone app (app/food in app.js): Open Food Facts, the free open
// food database (no key, no account). Only the barcode is sent; the answer is checked and cut down
// to the name and the carbs per 100 g and per serving.
//
// And favorite meals (app/meals): a meal logged with a name is kept with its usual carbs, so the
// next time it is one tap. Table public.su94r_meals (migration 20261003c_su94r_everyday.sql).

const OFF = 'https://world.openfoodfacts.org/api/v2/product';
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const round1 = (x) => Math.round(x * 10) / 10;
const clean = (s, max = 80) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** { found: false } or { found, code, name, per100, perServing, servingSize, servingGrams }. */
export async function foodByBarcode(code, { fetchImpl = (...a) => fetch(...a), es = false } = {}) {
  const c = String(code || '').replace(/\D/g, '');
  if (!/^\d{8,14}$/.test(c)) return { error: 'barcode' };
  const res = await fetchImpl(`${OFF}/${c}.json?fields=product_name,product_name_es,brands,serving_size,serving_quantity,nutriments`, {
    headers: { 'User-Agent': 'su94r/2 (self-hosted glucose app)', Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return { found: false, code: c };
  if (!res.ok) throw new Error(`Open Food Facts answered ${res.status}`);
  const j = await res.json().catch(() => null);
  const p = j?.product;
  if (!p || j.status === 0) return { found: false, code: c };
  const n = p.nutriments || {};
  const per100 = num(n.carbohydrates_100g);
  const servingGrams = num(p.serving_quantity);
  let perServing = num(n.carbohydrates_serving);
  if (perServing == null && per100 != null && servingGrams) perServing = round1((per100 * servingGrams) / 100);
  const brand = clean(String(p.brands || '').split(',')[0], 40);
  const name = clean((es && p.product_name_es) || p.product_name, 80);
  // The brand once: not again when the name already says it ("Nutella", not "Nutella · Nutella").
  const label = name && brand && name.toLowerCase().includes(brand.toLowerCase()) ? name : [brand, name].filter(Boolean).join(' · ');
  if (per100 == null && perServing == null) return { found: true, code: c, name: clean(label), per100: null, perServing: null, servingSize: null, servingGrams: null };
  return {
    found: true, code: c, name: clean(label) || c,
    per100: per100 == null ? null : round1(per100), perServing: perServing == null ? null : round1(perServing),
    servingSize: clean(p.serving_size, 40) || null, servingGrams,
  };
}

export function mealStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_meals`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('Favorite meals are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`Meal store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  return {
    ready,
    /** One person's favorites, the most used first. */
    list: (pid) => call(`?select=id,name,carbs,uses,last_used&pid=eq.${q(pid)}&order=uses.desc,last_used.desc&limit=12`),
    /** Keeps a meal as a favorite (same name, any case: one row, its carbs updated, used once more). */
    async use(pid, name, carbs, now = Date.now()) {
      const n = clean(name, 40);
      if (!n) return null;
      const found = (await call(`?select=id,uses&pid=eq.${q(pid)}&name_key=eq.${q(n.toLowerCase())}`))[0];
      const at = new Date(now).toISOString();
      if (found) await call(`?id=eq.${q(found.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ name: n, carbs, uses: (found.uses || 0) + 1, last_used: at }) });
      else await call('', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ pid, name: n, carbs, uses: 1, last_used: at }) });
      return n;
    },
    remove: (pid, id) => call(`?pid=eq.${q(pid)}&id=eq.${q(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  };
}
