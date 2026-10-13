// Opening Weeks service worker: network-first, so you always get the newest release data when online,
// and the last loaded version (plus posters you've seen) when offline.
const CACHE = 'opening-weeks-v3';
const IMAGES = 'opening-weeks-img-v1';
const SHELL = ['./', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'data/releases.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== IMAGES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // TMDB posters: cache-first (they never change), capped so the cache stays small.
  if (url.hostname === 'image.tmdb.org') {
    e.respondWith(caches.open(IMAGES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') {
        c.put(e.request, res.clone());
        c.keys().then(keys => { if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(k => c.delete(k)); });
      }
      return res;
    }));
    return;
  }

  if (url.origin !== location.origin) return;
  const cacheKey = url.pathname.endsWith('/data/releases.json') ? new Request(new URL('data/releases.json', self.registration.scope)) : e.request;
  e.respondWith(
    // 'no-cache' makes the phone check GitHub for a newer file instead of reusing its HTTP cache (up to 10 min).
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(cacheKey, copy)); }
        return res;
      })
      .catch(() => caches.match(cacheKey).then(r => r || caches.match(new URL('./', self.registration.scope))))
  );
});
