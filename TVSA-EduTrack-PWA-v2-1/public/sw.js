/**
 * TVSA EduTrack — Service Worker
 * Provides offline support & caching for PWA installation
 */

const CACHE_NAME    = 'tvsa-edutrack-v1';
const RUNTIME_CACHE = 'tvsa-runtime-v1';

// Core app shell files to cache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

// External CDN resources to cache at runtime
const CDN_ORIGINS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ── Install: precache app shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  const keep = [CACHE_NAME, RUNTIME_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for assets ────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and browser-extension requests
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  // API calls (sync endpoints) — network only, no caching
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sync')) {
    event.respondWith(fetch(request).catch(() =>
      new Response(JSON.stringify({ error: 'Offline — sync unavailable' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    ));
    return;
  }

  // CDN resources — cache-first (long-lived assets)
  if (CDN_ORIGINS.some(origin => url.hostname.includes(origin))) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => cached || new Response('', { status: 503 }));
        })
      )
    );
    return;
  }

  // App shell — stale-while-revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(request).then(cached => {
        const networkFetch = fetch(request).then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        }).catch(() => null);

        return cached || networkFetch || new Response(
          '<h2 style="font-family:sans-serif;padding:2rem;color:#f0a500">TVSA EduTrack<br><small style="color:#ccc">You are offline. Please reconnect to continue.</small></h2>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      })
    )
  );
});

// ── Background Sync (queued saves when offline) ──────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-data') {
    event.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'TRIGGER_SYNC' }))
      )
    );
  }
});

// ── Push Notifications (future use) ─────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json().catch(() => ({ title: 'TVSA EduTrack', body: event.data.text() }));
  event.waitUntil(
    data.then(d =>
      self.registration.showNotification(d.title || 'TVSA EduTrack', {
        body: d.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-72.png',
        vibrate: [200, 100, 200],
        data: d.url ? { url: d.url } : undefined
      })
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url === url && 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
