// Bump CACHE_VERSION on every deploy. A stale module served from an old
// cache is the one failure mode that would make the app lie about her data,
// so activation deletes every cache that is not this one.
const CACHE_VERSION = '1';
const CACHE_NAME = `cyclelog-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'src/ui/theme.css',
  'src/ui/app.js',
  'src/crypto.js',
  'src/store.js',
  'src/unlock.js',
  'src/biometric.js',
  'src/cycles.js',
  'src/confidence.js',
  'src/dates.js',
  'src/divergence.js',
  'src/episodes.js',
  'src/merge.js',
  'src/predict.js',
  'src/spans.js',
  'src/weighted.js',
  'src/stats.js',
  'src/importers/clue.js',
  'src/importers/legacy.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(hit => hit || fetch(request)),
  );
});
