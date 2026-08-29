/* ═══════════════════════════════════════════════════════════════
   Lurk — Service Worker
   Minimal shell-only caching to enable PWA install + instant load.
   We do NOT cache Firebase data or API responses — Lurk is a
   live-data app and stale data is worse than no data.
   ═══════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'lurk-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// On install, prefetch the shell.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_ASSETS).catch((err) => {
        // Don't block install if some assets are missing
        console.warn('SW: shell prefetch failed', err);
      })
    )
  );
  self.skipWaiting();
});

// On activate, clean up any old caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   - Same-origin shell requests: stale-while-revalidate
//   - Everything else (Firebase, Torn API via functions, fonts CDN, etc):
//     pass through to network. Never cache.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Pass through cross-origin (Firebase, Google APIs, fonts CDN, etc.)
  if (!isSameOrigin) return;

  // Skip Firebase Hosting reserved paths
  if (url.pathname.startsWith('/__/')) return;

  // Stale-while-revalidate for shell assets
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((response) => {
            // Only cache successful basic responses
            if (response && response.status === 200 && response.type === 'basic') {
              cache.put(req, response.clone());
            }
            return response;
          })
          .catch(() => cached); // offline → serve cached if we have it

        return cached || networkFetch;
      })
    )
  );
});
