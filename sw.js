// Service worker: keeps the app itself (not maps or forecasts) available offline,
// so it opens instantly from the home screen even on a weak connection.
// Bump VERSION when the list of files changes.

const VERSION = 'v5';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/coast.js',
  'js/geocode.js',
  'js/nav.js',
  'js/radar.js',
  'js/roads.js',
  'js/route.js',
  'js/storm.js',
  'js/watch.js',
  'js/weather.js',
  'js/wmo.js',
  'manifest.webmanifest',
  'icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App files: network first (so updates show up), cache as fallback.
// Everything else (tiles, routing, weather) goes straight to the network.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = url.origin === self.location.origin || url.href.startsWith('https://unpkg.com/maplibre-gl@');
  if (e.request.method !== 'GET' || !isShell) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
