// ═══════════════════════════════════════════════════════════════════════════
// Open Health Monitor — Free API Integrations
// LibreLinkUp | Dexcom Share | Nightscout | Google Fit | Open-Meteo |
// USDA FoodData | OpenFDA | Nutritionix | Fitbit | Garmin | Oura | Withings
// ═══════════════════════════════════════════════════════════════════════════

const ENV = import.meta.env;

// ════════════════════════════════════════════════════════════════════════════
// GLUCOSE APIs
// ════════════════════════════════════════════════════════════════════════════

// ── LibreLinkUp (Libre 2/3/3+) ────────────────────────────────────────────
export class LibreLinkUpAPI {
  static BASE = 'https://api.libreview.io';
  static token = null;
  static apiBase = LibreLinkUpAPI.BASE;

  static async login(email, password) {
    const res = await fetch(`${this.BASE}/llu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', product: 'llu.android', version: '4.7' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!data?.data?.authTicket?.token) throw new Error('Login failed');

    this.token = data.data.authTicket.token;
    if (data.data.redirect) {
      const regionBases = { ae:'api-ae',ap:'api-ap',au:'api-au',ca:'api-ca',de:'api-de',eu:'api-eu',eu2:'api-eu2',fr:'api-fr',jp:'api-jp',us:'api' };
      const prefix = regionBases[data.data.region] || 'api';
      this.apiBase = `https://${prefix}.libreview.io`;
      // Re-login with correct region
      const res2 = await fetch(`${this.apiBase}/llu/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', product: 'llu.android', version: '4.7' },
        body: JSON.stringify({ email, password }),
      });
      const data2 = await res2.json();
      this.token = data2?.data?.authTicket?.token;
    }
    return this.token;
  }

  static async getReadings() {
    if (!this.token) throw new Error('Not logged in');
    const res = await fetch(`${this.apiBase}/llu/connections`, {
      headers: { Authorization: `Bearer ${this.token}`, product: 'llu.android', version: '4.7' },
    });
    const data = await res.json();
    const connection = data?.data?.[0];
    if (!connection) throw new Error('No CGM connections found');

    const gm = connection.glucoseMeasurement;
    const graphData = connection.glucoseMeasurementHistory || [];

    return {
      current: {
        value: gm.Value,
        trend: gm.TrendArrow,
        timestamp: gm.FactoryTimestamp,
        unit: 'mg/dL',
        source: 'libre',
      },
      history: graphData.map(g => ({
        value: g.Value,
        trend: g.TrendArrow,
        timestamp: g.FactoryTimestamp,
      })).reverse(),
    };
  }
}

// ── Dexcom Share API ──────────────────────────────────────────────────────
export class DexcomShareAPI {
  static sessionId = null;

  static async login(username, password, server = 'us') {
    const host = server === 'ous' ? 'shareous1.dexcom.com' : 'share2.dexcom.com';
    const res = await fetch(`https://${host}/ShareWebServices/Services/General/AuthenticatePublisherAccount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountName: username, password, applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db' }),
    });
    const id = await res.json();
    if (!id || typeof id !== 'string') throw new Error('Dexcom login failed');
    this.sessionId = id;
    this.host = host;
    return id;
  }

  static async getReadings(count = 36) {
    if (!this.sessionId) throw new Error('Not logged in');
    const res = await fetch(
      `https://${this.host}/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${this.sessionId}&minutes=180&maxCount=${count}`
    );
    const readings = await res.json();
    if (!readings?.length) throw new Error('No readings');

    // Dexcom trend map: 1=None, 2=DoubleUp, 3=SingleUp, 4=FortyFiveUp, 5=Flat, 6=FortyFiveDown, 7=SingleDown, 8=DoubleDown, 9=NotComputable
    const trendMap = { 1:3, 2:5, 3:5, 4:4, 5:3, 6:2, 7:2, 8:1, 9:3 };

    return {
      current: {
        value: readings[0].Value,
        trend: trendMap[readings[0].Trend] || 3,
        timestamp: readings[0].DT,
        source: 'dexcom',
      },
      history: readings.map(r => ({
        value: r.Value,
        trend: trendMap[r.Trend] || 3,
        timestamp: r.DT,
      })),
    };
  }
}

// ── Nightscout API (self-hosted, free) ────────────────────────────────────
export class NightscoutAPI {
  static async getReadings(url, token, count = 36) {
    const headers = token ? { 'api-secret': token } : {};
    const res = await fetch(`${url}/api/v1/entries.json?count=${count}`, { headers });
    const entries = await res.json();
    if (!entries?.length) throw new Error('No Nightscout entries');

    const dirMap = { Flat:3, FortyFiveDown:2, FortyFiveUp:4, SingleDown:1, SingleUp:5, DoubleDown:1, DoubleUp:5, NOT_COMPUTABLE:3 };

    return {
      current: {
        value: entries[0].sgv,
        trend: dirMap[entries[0].direction] || 3,
        timestamp: new Date(entries[0].dateString).toISOString(),
        source: 'nightscout',
      },
      history: entries.map(e => ({
        value: e.sgv,
        trend: dirMap[e.direction] || 3,
        timestamp: new Date(e.dateString).toISOString(),
      })),
    };
  }

  static async getTreatments(url, token, count = 20) {
    const headers = token ? { 'api-secret': token } : {};
    const res = await fetch(`${url}/api/v1/treatments.json?count=${count}`, { headers });
    return res.json();
  }

  static async getDeviceStatus(url, token) {
    const headers = token ? { 'api-secret': token } : {};
    const res = await fetch(`${url}/api/v1/devicestatus.json?count=1`, { headers });
    return res.json();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FITNESS APIs
// ════════════════════════════════════════════════════════════════════════════

// ── Open-Meteo (FREE, no key needed) ─────────────────────────────────────
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
    // Glucose note: cold weather → more insulin resistance; low pressure → some report glucose fluctuations
    glucoseNote: c.temperature_2m < 10
      ? 'Cold weather may increase insulin resistance'
      : c.precipitation > 0
      ? 'Rainy day — reduced activity may affect glucose'
      : null,
  };
}

// ── Google Fit (requires OAuth, free) ─────────────────────────────────────
export class GoogleFitAPI {
  static async getSteps(accessToken, startMs, endMs) {
    const body = {
      aggregateBy: [{ dataTypeName: 'com.google.step_count.delta' }],
      bucketByTime: { durationMillis: 86400000 },
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    };
    const res = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.bucket?.map(b => ({
      date: new Date(parseInt(b.startTimeMillis)).toISOString().split('T')[0],
      steps: b.dataset[0]?.point[0]?.value[0]?.intVal || 0,
    })) || [];
  }

  static async getHeartRate(accessToken, startMs, endMs) {
    const body = {
      aggregateBy: [{ dataTypeName: 'com.google.heart_rate.bpm' }],
      bucketByTime: { durationMillis: 3600000 }, // hourly
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    };
    const res = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.bucket?.flatMap(b =>
      b.dataset[0]?.point?.map(p => ({
        timestamp: new Date(parseInt(p.startTimeNanos) / 1e6).toISOString(),
        bpm: p.value[0]?.fpVal || 0,
      })) || []
    ) || [];
  }
}

// ── Fitbit API (free with device) ─────────────────────────────────────────
export class FitbitAPI {
  static async getActivitySummary(accessToken, date = 'today') {
    const res = await fetch(`https://api.fitbit.com/1/user/-/activities/date/${date}.json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    return {
      steps: data.summary?.steps || 0,
      calories: data.summary?.caloriesOut || 0,
      activeMinutes: data.summary?.fairlyActiveMinutes + data.summary?.veryActiveMinutes || 0,
      distance: data.summary?.distances?.[0]?.distance || 0,
    };
  }

  static async getSleepLog(accessToken, date = 'today') {
    const res = await fetch(`https://api.fitbit.com/1.2/user/-/sleep/date/${date}.json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    const main = data.sleep?.[0];
    return {
      duration: main?.duration || 0,
      efficiency: main?.efficiency || 0,
      stages: main?.levels?.summary || {},
      startTime: main?.startTime,
      endTime: main?.endTime,
    };
  }

  static async getHeartRate(accessToken, date = 'today') {
    const res = await fetch(`https://api.fitbit.com/1/user/-/activities/heart/date/${date}/1d/1min.json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    return {
      restingHR: data['activities-heart']?.[0]?.value?.restingHeartRate || null,
      zones: data['activities-heart']?.[0]?.value?.heartRateZones || [],
    };
  }
}

// ── Oura Ring API v2 (free with ring) ────────────────────────────────────
export class OuraAPI {
  static async getDailySleep(token, startDate, endDate) {
    const res = await fetch(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.data?.map(d => ({
      date: d.day,
      score: d.score,
      totalSleep: d.contributors?.total_sleep,
      deepSleep: d.contributors?.deep_sleep,
      remSleep: d.contributors?.rem_sleep,
      efficiency: d.contributors?.efficiency,
    })) || [];
  }

  static async getDailyReadiness(token, startDate, endDate) {
    const res = await fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${startDate}&end_date=${endDate}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.data?.map(d => ({
      date: d.day,
      score: d.score,
      hrv: d.contributors?.hrv_balance,
      recovery: d.contributors?.recovery_index,
    })) || [];
  }

  static async getHeartRate(token, startDateTime, endDateTime) {
    const res = await fetch(`https://api.ouraring.com/v2/usercollection/heartrate?start_datetime=${startDateTime}&end_datetime=${endDateTime}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.data || [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// NUTRITION APIs
// ════════════════════════════════════════════════════════════════════════════

// ── USDA FoodData Central (free, requires free key) ───────────────────────
export async function searchFood(query) {
  const key = ENV.VITE_USDA_API_KEY || 'DEMO_KEY';
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

// ── Nutritionix (free tier: 500 req/day) ─────────────────────────────────
export async function getNutritionixData(query) {
  const appId = ENV.VITE_NUTRITIONIX_APP_ID;
  const appKey = ENV.VITE_NUTRITIONIX_API_KEY;
  if (!appId || !appKey) return null;

  const res = await fetch('https://trackapi.nutritionix.com/v2/natural/nutrients', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-app-id': appId,
      'x-app-key': appKey,
    },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  return data.foods?.map(f => ({
    name: f.food_name,
    serving: `${f.serving_qty} ${f.serving_unit}`,
    calories: f.nf_calories,
    carbs: f.nf_total_carbohydrate,
    protein: f.nf_protein,
    fat: f.nf_total_fat,
    fiber: f.nf_dietary_fiber,
    sugar: f.nf_sugars,
    gi: f.nf_dietary_fiber < 3 ? 'High' : 'Moderate', // rough estimate
  })) || [];
}

// ── OpenFDA Drug Database (free, no key needed) ───────────────────────────
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
    adverseReactions: result.adverse_reactions?.[0]?.substring(0, 300),
    indications: result.indications_and_usage?.[0]?.substring(0, 300),
  };
}

// ── PubMed / NIH API (free) ───────────────────────────────────────────────
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
    return {
      pmid: id,
      title: item?.title,
      authors: item?.authors?.map(a => a.name).join(', '),
      journal: item?.fulljournalname,
      pubDate: item?.pubdate,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    };
  }).filter(i => i.title);
}

// ── Withings Health Mate API (free with device) ───────────────────────────
export class WithingsAPI {
  static async getBodyMeasures(accessToken, measType = 1) {
    // measType: 1=weight, 9=diastolic BP, 10=systolic BP, 54=SpO2, 88=fatMass
    const res = await fetch(`https://wbsapi.withings.net/measure?action=getmeas&meastype=${measType}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    return data.body?.measuregrps?.map(g => ({
      date: new Date(g.date * 1000).toISOString(),
      value: g.measures[0]?.value * Math.pow(10, g.measures[0]?.unit || 0),
    })) || [];
  }
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
