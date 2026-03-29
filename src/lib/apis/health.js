// ═══════════════════════════════════════════════════════════════════════════
// Open Health Monitor — Free API Integrations (via Cloudflare Proxy)
// LibreLinkUp | Dexcom Share | Nightscout | Google Fit | Open-Meteo |
// USDA FoodData | OpenFDA | Nutritionix | Fitbit | Garmin | Oura | Withings
// ═══════════════════════════════════════════════════════════════════════════

const PROXY = 'https://su94r-proxy.ken-e90.workers.dev';

// ════════════════════════════════════════════════════════════════════════════
// GLUCOSE APIs (via CORS proxy)
// ════════════════════════════════════════════════════════════════════════════

export class LibreLinkUpAPI {
  static token = null;
  static apiBase = null;

  static async login(email, password) {
    const res = await fetch(`${PROXY}/libre/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.token) throw new Error('Login failed — check your LibreLink email and password');
    this.token = data.token;
    this.apiBase = data.apiBase;
    return this.token;
  }

  static async getReadings() {
    if (!this.token) throw new Error('Not logged in');
    const res = await fetch(`${PROXY}/libre/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.token, apiBase: this.apiBase }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }
}

export class DexcomShareAPI {
  static sessionId = null;
  static host = null;

  static async login(username, password, server = 'us') {
    const res = await fetch(`${PROXY}/dexcom/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, server }),
    });
    const data = await res.json();
    if (!data.sessionId || typeof data.sessionId !== 'string') throw new Error('Dexcom login failed');
    this.sessionId = data.sessionId;
    this.host = data.host;
    return data.sessionId;
  }

  static async getReadings(count = 36) {
    if (!this.sessionId) throw new Error('Not logged in');
    const res = await fetch(`${PROXY}/dexcom/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId, host: this.host }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }
}

export class NightscoutAPI {
  static async getReadings(url, token, count = 36) {
    const res = await fetch(`${PROXY}/nightscout/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FITNESS APIs (direct — these support CORS)
// ════════════════════════════════════════════════════════════════════════════

export async function getWeather(lat, lon) {
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weathercode,pressure_msl&timezone=auto`
  );
  const data = await res.json();
  const c = data.current;
  return {
    temp: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    pressure: c.pressure_msl,
    precipitation: c.precipitation,
    code: c.weathercode,
    glucoseNote: c.temperature_2m < 10
      ? 'Cold weather may increase insulin resistance'
      : c.precipitation > 0
      ? 'Rainy day — reduced activity may affect glucose'
      : null,
  };
}

export async function searchFood(query) {
  const key = 'DEMO_KEY';
  const res = await fetch(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&api_key=${key}&pageSize=5&dataType=SR%20Legacy,Survey%20(FNDDS)`
  );
  const data = await res.json();
  return data.foods?.map(f => ({
    name: f.description,
    fdcId: f.fdcId,
    carbs: f.foodNutrients?.find(n => n.nutrientName === 'Carbohydrate, by difference')?.value || 0,
    protein: f.foodNutrients?.find(n => n.nutrientName === 'Protein')?.value || 0,
    fat: f.foodNutrients?.find(n => n.nutrientName === 'Total lipid (fat)')?.value || 0,
    calories: f.foodNutrients?.find(n => n.nutrientName === 'Energy')?.value || 0,
    fiber: f.foodNutrients?.find(n => n.nutrientName === 'Fiber, total dietary')?.value || 0,
    per100g: true,
  })) || [];
}

export async function searchDrug(drugName) {
  const res = await fetch(
    `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${encodeURIComponent(drugName)}"&limit=1`
  );
  const data = await res.json();
  const result = data.results?.[0];
  if (!result) return null;
  return {
    name: result.openfda?.brand_name?.[0] || drugName,
    genericName: result.openfda?.generic_name?.[0],
    warnings: result.warnings?.[0]?.substring(0, 500),
    interactions: result.drug_interactions?.[0]?.substring(0, 500),
  };
}

export async function searchMedicalResearch(query) {
  const searchRes = await fetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query + ' type 1 diabetes')}&retmode=json&retmax=5`
  );
  const searchData = await searchRes.json();
  const ids = searchData.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const summaryRes = await fetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`
  );
  const summaryData = await summaryRes.json();
  return ids.map(id => {
    const item = summaryData.result?.[id];
    return { pmid: id, title: item?.title, authors: item?.authors?.map(a => a.name).join(', '), journal: item?.fulljournalname, pubDate: item?.pubdate, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/` };
  }).filter(i => i.title);
}

// ════════════════════════════════════════════════════════════════════════════
// UNIFIED DATA FETCHER
// ════════════════════════════════════════════════════════════════════════════
export async function fetchAllHealthData(config) {
  const results = { glucose: null, activity: null, sleep: null, weather: null, error: [] };

  // Glucose
  try {
    if (config.glucoseSource === 'libre' && config.libreEmail) {
      await LibreLinkUpAPI.login(config.libreEmail, config.librePassword);
      results.glucose = await LibreLinkUpAPI.getReadings();
    } else if (config.glucoseSource === 'dexcom' && config.dexcomUser) {
      await DexcomShareAPI.login(config.dexcomUser, config.dexcomPass, config.dexcomServer);
      results.glucose = await DexcomShareAPI.getReadings();
    } else if (config.glucoseSource === 'nightscout' && config.nightscoutUrl) {
      results.glucose = await NightscoutAPI.getReadings(config.nightscoutUrl, config.nightscoutToken);
    }
  } catch (e) { results.error.push(`Glucose: ${e.message}`); }

  // Weather (no key needed)
  try {
    if (navigator.geolocation) {
      const pos = await new Promise(resolve => navigator.geolocation.getCurrentPosition(resolve, () => resolve(null)));
      if (pos) results.weather = await getWeather(pos.coords.latitude, pos.coords.longitude);
    }
  } catch { /* Weather is optional */ }

  return results;
}
