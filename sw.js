// CACHE bumped to v3 — this forces the service worker to drop every old
// cached file (admin.js v2 had a stale bug that called initSettingsForm()
// inside initDashboard; if your browser is still serving the old file,
// hard-refresh once or bump this again).
const CACHE_NAME = 'g16-nti-v3';
const STATIC_ASSETS = [
  './',
  './index.html',
  './main.css',
  './main.js',
  './firebase-config.js',
  './392010.html',
  './admin.css',
  './admin.js',
  './firestore.rules',
  './manifest.json'
];

// Install: Cache static assets (best-effort; don't block on optional files)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[sw] failed to cache', url, err?.message || err);
          })
        )
      );
    })
  );
  // Force-activate: the new SW takes over open tabs without waiting
  // for them to be closed. This is the key to busting the stale cache.
  self.skipWaiting();
});

// Activate: Clean old caches and take control of all open tabs
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[sw] deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Listen for messages from the page (used to force-skipWaiting on demand).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))))
    );
  }
});

// Fetch: Cache First for static, Network First for Firebase
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle http(s) — chrome-extension://, file://, data:, etc. would
  // throw "Request scheme X is unsupported" in the Cache API. The browser
  // will fall through to its normal handler for those.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Firebase / API requests: Network only
  if (url.hostname.includes('firebase') || url.hostname.includes('googleapis')) {
    event.respondWith(fetch(request).catch(() => {
      return new Response(JSON.stringify({ offline: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }));
    return;
  }

  // Static assets: Cache First
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Only cache successful basic responses — no opaque cross-origin
        // responses (they break cache.put).
        if (response && response.status === 200 && response.type === 'basic' && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return response;
      });
    }).catch(() => {
      // Fallback for HTML pages
      if (request.destination === 'document') {
        return caches.match('./index.html');
      }
    })
  );
});
