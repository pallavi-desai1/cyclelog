// Bump CACHE_VERSION on every deploy. A stale module served from an old
// cache is the one failure mode that would make the app lie about her data,
// so activation deletes every cache that is not this one.
const CACHE_VERSION = '12';
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
  'src/summary.js',
  'src/sync/key.js',
  'src/sync/scope.js',
  'src/sync/firestore.js',
  'src/sync/share.js',
  'src/calendar.js',
  'src/day.js',
  'src/importers/clue.js',
  'src/importers/legacy.js',
  'src/import.js',
  'src/export.js',
  'src/restore.js',
  'src/edit.js',
  'src/ui/render.js',
  'src/ui/editor.js',
  'src/ui/share.js',
  'src/config.js',
  'src/today.js',
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

// Network first, with the cache as the offline fallback.
//
// Cache-first was the wrong trade here. It pinned an old shell against a new
// one: a worker installed before the calendar existed kept serving its cached
// copy of index.html and theme.css, so the app came up with no calendar and
// no fonts and no reload could get past it. Offline support is worth a lot,
// but not at the price of a device stuck on an old version of her app.
async function respond(request) {
  try {
    const response = await fetch(request);
    // Only a success is worth keeping; a 404 cached here would outlive the
    // mistake that caused it.
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, copy);
    }
    return response;
  } catch (networkError) {
    const cached = await caches.match(request);
    // respondWith(undefined) throws, which would turn an offline miss into a
    // broken page rather than a plain network error.
    return cached ?? Response.error();
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(respond(request));
});
