// ═══════════════════════════════════════════════════════════════════════════
// Open Health Monitor — Service Worker
// Handles: Push notifications, offline cache, background glucose fetch
// ═══════════════════════════════════════════════════════════════════════════
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';

// Injected by Vite PWA plugin
precacheAndRoute(self.__WB_MANIFEST || []);
cleanupOutdatedCaches();

const CACHE_V = 'ohm-v1';
const GLUCOSE_POLL_INTERVAL = 5 * 60 * 1000; // 5 min

// ── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_V).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Push Notification Handler ──────────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  
  let payload;
  try { payload = e.data.json(); }
  catch { payload = { title: 'Health Alert', body: e.data.text(), urgency: 'normal' }; }

  const { title, body, icon, urgency = 'normal', type, glucose, trend, actions: customActions } = payload;

  // Build notification options based on urgency
  const isCritical = urgency === 'critical';
  const isWarning = urgency === 'warning';

  const options = {
    body: body || 'Check your health metrics',
    icon: icon || '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: type || 'health-alert',
    renotify: true,
    requireInteraction: isCritical || isWarning,
    silent: false,
    timestamp: Date.now(),
    data: { url: '/', type, glucose, trend, urgency },

    // Vibration pattern
    vibrate: isCritical
      ? [500, 200, 500, 200, 500, 200, 500] // SOS-style
      : isWarning
      ? [300, 100, 300]
      : [200],

    // Action buttons
    actions: customActions || (isCritical
      ? [
          { action: 'view', title: '👁 View Now', icon: '/icons/action-view.png' },
          { action: 'im-ok', title: '✓ I\'m OK', icon: '/icons/action-ok.png' },
          { action: 'call-911', title: '📞 Call 911', icon: '/icons/action-911.png' },
        ]
      : isWarning
      ? [
          { action: 'view', title: 'View Dashboard', icon: '/icons/action-view.png' },
          { action: 'snooze', title: '⏰ Snooze 15min', icon: '/icons/action-snooze.png' },
        ]
      : [
          { action: 'view', title: 'View', icon: '/icons/action-view.png' },
        ]),
  };

  e.waitUntil(
    self.registration.showNotification(title || buildTitle(type, glucose, urgency), options)
  );
});

function buildTitle(type, glucose, urgency) {
  const icons = { very_low: '🚨', low: '⚠️', high: '📈', very_high: '🚨', normal: '✓' };
  const labels = { very_low: 'CRITICAL LOW', low: 'LOW GLUCOSE', high: 'HIGH GLUCOSE', very_high: 'CRITICAL HIGH', normal: 'In Range' };
  const g = glucose ? ` — ${glucose} mg/dL` : '';
  return `${icons[type] || '🔔'} ${labels[type] || 'Health Alert'}${g}`;
}

// ── Notification Click Handler ─────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { url, type } = e.notification.data || {};
  const action = e.action;

  if (action === 'call-911') {
    e.waitUntil(clients.openWindow('tel:911'));
    return;
  }

  if (action === 'snooze') {
    // Store snooze in indexedDB — will be read by app to suppress next alert
    e.waitUntil(
      setSnooze(type, 15 * 60 * 1000)
    );
    return;
  }

  // Open/focus app
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const tabUrl = url || '/';
      for (const client of clientList) {
        if (client.url === tabUrl && 'focus' in client) return client.focus();
      }
      return clients.openWindow(tabUrl);
    })
  );
});

// ── Background Sync — Glucose Polling ─────────────────────────────────────
// Polls glucose every 5 min even when app is closed (Android Chrome)
// Requires: Background Sync API (Chrome/Edge Android)
self.addEventListener('periodicsync', e => {
  if (e.tag === 'glucose-sync') {
    e.waitUntil(backgroundGlucoseCheck());
  }
});

async function backgroundGlucoseCheck() {
  try {
    // Read config from IndexedDB
    const config = await getConfig();
    if (!config?.glucoseSource) return;

    let glucose = null;
    
    // Try LibreLinkUp
    if (config.glucoseSource === 'libre' && config.libreEmail && config.librePassword) {
      glucose = await fetchLibreGlucose(config);
    }
    // Try Dexcom Share
    else if (config.glucoseSource === 'dexcom' && config.dexcomUser) {
      glucose = await fetchDexcomGlucose(config);
    }
    // Try Nightscout
    else if (config.glucoseSource === 'nightscout' && config.nightscoutUrl) {
      glucose = await fetchNightscoutGlucose(config);
    }

    if (!glucose) return;

    // Check thresholds and notify
    await checkAndNotify(glucose, config);

    // Broadcast to open clients
    const clientList = await clients.matchAll({ type: 'window' });
    clientList.forEach(client => client.postMessage({ type: 'GLUCOSE_UPDATE', glucose }));
  } catch (err) {
    console.error('[SW] Background glucose check failed:', err);
  }
}

async function checkAndNotify(glucose, config) {
  const { value, trend } = glucose;
  const thresholds = config.thresholds || { veryLow: 55, low: 70, high: 180, veryHigh: 250 };

  // Check snooze
  const snoozeUntil = await getSnooze('glucose');
  if (snoozeUntil && Date.now() < snoozeUntil) return;

  let type = 'normal', urgency = 'normal', shouldNotify = false;

  if (value < thresholds.veryLow) { type = 'very_low'; urgency = 'critical'; shouldNotify = true; }
  else if (value < thresholds.low) { type = 'low'; urgency = 'warning'; shouldNotify = true; }
  else if (value > thresholds.veryHigh) { type = 'very_high'; urgency = 'critical'; shouldNotify = true; }
  else if (value > thresholds.high) { type = 'high'; urgency = 'warning'; shouldNotify = true; }
  else if (trend === 1) { type = 'dropping_fast'; urgency = 'warning'; shouldNotify = true; } // Dropping fast
  else if (trend === 5) { type = 'rising_fast'; urgency = 'warning'; shouldNotify = true; }

  if (!shouldNotify) return;

  const trendText = ['','⬇ Dropping Fast','↘ Dropping','→ Stable','↗ Rising','⬆ Rising Fast'][trend] || '';
  const bodies = {
    very_low: `${value} mg/dL ${trendText} — Treat immediately with fast carbs`,
    low: `${value} mg/dL ${trendText} — Eat 15g fast carbs now`,
    very_high: `${value} mg/dL ${trendText} — Check for ketones, consider correction`,
    high: `${value} mg/dL ${trendText} — Consider correction or activity`,
    dropping_fast: `${value} mg/dL and dropping fast — Prepare fast carbs`,
    rising_fast: `${value} mg/dL and rising fast — Consider pre-bolus`,
  };

  await self.registration.showNotification(buildTitle(type, value, urgency), {
    body: bodies[type] || `${value} mg/dL`,
    tag: 'glucose-alert',
    renotify: true,
    requireInteraction: urgency === 'critical',
    vibrate: urgency === 'critical' ? [500,200,500,200,500] : [300,100,300],
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: '/?tab=dashboard', type, glucose: value, trend, urgency },
    actions: urgency === 'critical'
      ? [{ action: 'view', title: '👁 View Now' }, { action: 'im-ok', title: '✓ I\'m OK' }]
      : [{ action: 'view', title: 'View' }, { action: 'snooze', title: '⏰ +15min' }],
  });
}

// ── LibreLinkUp fetch ──────────────────────────────────────────────────────
async function fetchLibreGlucose(config) {
  const loginRes = await fetch('https://api.libreview.io/llu/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', product: 'llu.android', version: '4.7' },
    body: JSON.stringify({ email: config.libreEmail, password: config.librePassword }),
  });
  const loginData = await loginRes.json();
  const token = loginData?.data?.authTicket?.token;
  if (!token) return null;

  const connRes = await fetch('https://api.libreview.io/llu/connections', {
    headers: { Authorization: `Bearer ${token}`, product: 'llu.android', version: '4.7' },
  });
  const connData = await connRes.json();
  const gm = connData?.data?.[0]?.glucoseMeasurement;
  if (!gm) return null;
  return { value: gm.Value, trend: gm.TrendArrow, timestamp: gm.FactoryTimestamp, source: 'libre' };
}

// ── Dexcom Share fetch ─────────────────────────────────────────────────────
async function fetchDexcomGlucose(config) {
  const server = config.dexcomServer === 'ous' ? 'shareous1.dexcom.com' : 'share2.dexcom.com';
  const sessionRes = await fetch(`https://${server}/ShareWebServices/Services/General/AuthenticatePublisherAccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountName: config.dexcomUser, password: config.dexcomPass, applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db' }),
  });
  const sessionId = await sessionRes.json();
  if (!sessionId || sessionId.Code) return null;

  const readRes = await fetch(`https://${server}/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionId}&minutes=10&maxCount=1`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const readings = await readRes.json();
  if (!readings?.length) return null;
  const r = readings[0];
  return { value: r.Value, trend: r.Trend, timestamp: r.DT, source: 'dexcom' };
}

// ── Nightscout fetch ───────────────────────────────────────────────────────
async function fetchNightscoutGlucose(config) {
  const headers = config.nightscoutToken ? { 'api-secret': config.nightscoutToken } : {};
  const res = await fetch(`${config.nightscoutUrl}/api/v1/entries.json?count=1`, { headers });
  const entries = await res.json();
  if (!entries?.length) return null;
  const e = entries[0];
  // Nightscout trend map: Flat=4, FortyFiveDown=5, FortyFiveUp=3, SingleDown=6, SingleUp=2, DoubleDown=7, DoubleUp=1
  const trendMap = { Flat: 3, FortyFiveDown: 2, FortyFiveUp: 4, SingleDown: 1, SingleUp: 5, DoubleDown: 1, DoubleUp: 5, NOT_COMPUTABLE: 3 };
  return { value: e.sgv, trend: trendMap[e.direction] || 3, timestamp: new Date(e.dateString).toISOString(), source: 'nightscout' };
}

// ── IndexedDB helpers ──────────────────────────────────────────────────────
async function getDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('open-health-monitor', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config');
      if (!db.objectStoreNames.contains('snooze')) db.createObjectStore('snooze');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getConfig() {
  const db = await getDB();
  return new Promise(resolve => {
    const tx = db.transaction('config', 'readonly');
    const req = tx.objectStore('config').get('settings');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function getSnooze(type) {
  const db = await getDB();
  return new Promise(resolve => {
    const tx = db.transaction('snooze', 'readonly');
    const req = tx.objectStore('snooze').get(type);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function setSnooze(type, durationMs) {
  const db = await getDB();
  return new Promise(resolve => {
    const tx = db.transaction('snooze', 'readwrite');
    tx.objectStore('snooze').put(Date.now() + durationMs, type);
    tx.oncomplete = resolve;
  });
}

// ── Message handler (from app) ─────────────────────────────────────────────
self.addEventListener('message', async e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'SNOOZE') await setSnooze(e.data.alertType, e.data.duration);
  if (e.data?.type === 'CHECK_NOW') await backgroundGlucoseCheck();
});
