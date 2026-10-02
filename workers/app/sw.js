// The su94r phone app's service worker: it keeps the app's own files so the app opens without a
// connection (showing the last reading the page saved). Readings and every other request always
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
