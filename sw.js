// ==========================================================================
//  sw.js
//  Offline Service Worker for NES Tetris PWA (SPEC §6).
//  Implements cache-first strategy with network fallback.
// ==========================================================================

const CACHE_NAME = 'nes-tetris-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/game.js',
  './src/input.js',
  './src/audio.js',
  './src/ui.js',
  './src/board.js',
  './src/config.js',
  './src/pieces.js',
  './src/progression.js',
  './src/renderer.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Install: pre-cache all static assets and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: prune previous caches and claim active clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first with network fallback for local origin requests
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Only handle requests for this origin
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        });
      })
    );
  }
});
