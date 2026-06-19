// Kriolu PWA Service Worker
const CACHE_NAME = 'kriolu-v14';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - NEVER intercept API calls (Anthropic) — always go to network
// - App files: network-first so updates arrive, fall back to cache when offline
// - Fonts/CDN: cache-first since they rarely change
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache or intercept API calls
  if (url.hostname.includes('anthropic.com')) return;
  if (url.hostname.includes('elevenlabs.io')) return;
  if (url.pathname.includes('/api/tts') || url.pathname.includes('/.netlify/')) return;

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Fonts and CDN assets: cache-first
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return resp;
        })
      )
    );
    return;
  }

  // App files: network-first, cache fallback (offline mode)
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return resp;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
    );
  }
});
