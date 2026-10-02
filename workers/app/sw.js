// The su94r phone app's service worker: it keeps the app's own files so the app opens without a
// connection (showing the last reading the page saved), and it shows the low alerts the server
// pushes (workers/webpush.js), with an "I'm OK" button. Readings and every other request always
// go to the network and are never stored here.
const CACHE = 'su94r-app-1';
const SHELL = ['/app/', '/app/app.js', '/app/manifest.webmanifest', '/app/icon.svg', '/app/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || !SHELL.includes(u.pathname)) return;
  // Network first, so a new version arrives at once; the saved copy only when offline.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(u.pathname, copy)); }
    return r;
  }).catch(() => caches.match(u.pathname)));
});

// An alert from the server: { title, body, tag, urgent, ack } (ack: the "I'm OK" address).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'su94r', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'su94r', {
    body: d.body || '',
    tag: d.tag || 'su94r-info',
    renotify: true,
    requireInteraction: Boolean(d.urgent),
    icon: '/app/icon-192.png',
    badge: '/app/icon-192.png',
    vibrate: d.urgent ? [500, 200, 500, 200, 900] : [200, 100, 200],
    data: { ack: d.ack || null },
    actions: d.ack ? [{ action: 'ok', title: "I'm OK" }] : [],
  }));
});

self.addEventListener('notificationclick', (e) => {
  const ack = (e.notification.data || {}).ack;
  e.notification.close();
  if (e.action === 'ok' && ack) {
    e.waitUntil(fetch(ack, { method: 'POST' }).then((r) => self.registration.showNotification(r.ok ? 'Got it' : 'su94r', {
      body: r.ok ? 'Reminders for this low stop. A severe low still tells you once.' : 'That alert was already answered.',
      tag: 'su94r-alert', icon: '/app/icon-192.png',
    })).catch(() => {}));
    return;
  }
  // Tapped (or a phone without buttons): open the app; it offers "I'm OK" for this alert.
  const target = ack ? '/app/?ack=' + (ack.split('t=')[1] || '') : '/app/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).pathname.indexOf('/app/') === 0);
    if (open) { open.postMessage({ ack: ack || null }); return open.focus(); }
    return self.clients.openWindow(target);
  }));
});
