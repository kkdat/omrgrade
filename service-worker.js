/* OMR AutoGrader — offline cache.
 * Everything the app needs is stored on first visit, so it opens with no network.
 */
const CACHE_NAME = 'omr-autograder-v2';
const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './omr.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './vendor/tailwind.js',
  './vendor/jspdf.umd.min.js',
  './vendor/opencv.js',
  './vendor/fa.css',
  './vendor/webfonts/fa-solid-900.woff2',
  './vendor/webfonts/fa-regular-400.woff2',
  './vendor/webfonts/fa-brands-400.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // Navigations: network first, so a new version is picked up; cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('./index.html')) || (await cache.match('./')) ||
          new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Assets: serve cached instantly, refresh in the background (stale-while-revalidate).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const update = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    if (cached) return cached;
    const fresh = await update;
    return fresh || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  })());
});

// The page can ask for a full re-cache ("Save offline" button).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'PRECACHE') return;
  const port = event.ports && event.ports[0];
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => port && port.postMessage({ ok: true }))
      .catch((err) => {
        console.warn('Precache failed', err);
        if (port) port.postMessage({ ok: false, error: String(err) });
      })
  );
});
