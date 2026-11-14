const CACHE_VERSION = 'proximetria-v1.0.0';
const CORE_CACHE = `${CACHE_VERSION}-core`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;

const CORE = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './config.json',
  './assets/css/app.css',
  './assets/js/app.js',
  './assets/js/distance-worker.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './dados/sitios_brasil.json',
  './dados/sitios_brasil.meta.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CORE_CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin && url.pathname.includes('/dados/')) {
    event.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  if (/tile\.openstreetmap\.org|opentopomap\.org/.test(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, TILE_CACHE, 350));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, CORE_CACHE, './offline.html'));
    return;
  }

  event.respondWith(staleWhileRevalidate(req, CORE_CACHE));
});

async function networkFirst(request, cacheName, fallbackUrl = null) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request) || await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) return caches.match(fallbackUrl);
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName, maxEntries = null) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request) || await caches.match(request);
  const network = fetch(request).then(async response => {
    if (response && (response.ok || response.type === 'opaque')) {
      await cache.put(request, response.clone());
      if (maxEntries) await trimCache(cacheName, maxEntries);
    }
    return response;
  }).catch(() => null);
  if (cached) return cached;
  const response = await network;
  return response || Response.error();
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await cache.delete(keys[0]);
  return trimCache(cacheName, maxEntries);
}
