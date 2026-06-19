// =============================================
//  Lender Admin — Service Worker  v1.0.0
// =============================================

const CACHE_NAME = 'lender-admin-v1';
const OFFLINE_URL = './index.html';

// Assets to pre-cache on install
const PRECACHE_ASSETS = [
  './index.html',
  './admin-dashboard.css',
  './admin-dashboard.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './screenshot.png',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=JetBrains+Mono:wght@300;400;500;600&display=swap',
  'https://unpkg.com/lucide@latest'
];

// ── INSTALL ────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing Lender Admin Service Worker…');

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching app shell…');
      // Cache each asset individually so one failure doesn't break everything
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn(`[SW] Failed to cache: ${url}`, err)
          )
        )
      );
    }).then(() => {
      console.log('[SW] Pre-cache complete.');
      return self.skipWaiting(); // Activate immediately
    })
  );
});

// ── ACTIVATE ───────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating…');

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((oldCache) => {
            console.log(`[SW] Deleting old cache: ${oldCache}`);
            return caches.delete(oldCache);
          })
      );
    }).then(() => {
      console.log('[SW] Now ready to handle fetches.');
      return self.clients.claim(); // Take control of all open tabs
    })
  );
});

// ── FETCH ──────────────────────────────────────
// Strategy: Cache-first for local assets, Network-first for external/API
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip browser extension and devtools requests
  if (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') return;

  // ── Firebase / API calls: Network-only (never cache) ──
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com')
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Local assets: Cache-first, then network ──
  if (url.origin === self.location.origin || isLocalAsset(url)) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          // Serve from cache; refresh cache in the background
          refreshCache(request);
          return cachedResponse;
        }
        // Not in cache — try network and cache the result
        return fetchAndCache(request);
      }).catch(() => {
        // If everything fails, serve the offline page
        return caches.match(OFFLINE_URL);
      })
    );
    return;
  }

  // ── External fonts & CDN: Cache-first ──
  if (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('unpkg.com')
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        return cachedResponse || fetchAndCache(request);
      }).catch(() => {
        return new Response('', { status: 503, statusText: 'Offline' });
      })
    );
    return;
  }

  // ── Default: Network with cache fallback ──
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) cacheResponse(request, response.clone());
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// ── HELPERS ────────────────────────────────────

function isLocalAsset(url) {
  return (
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.woff2')
  );
}

async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response.ok) {
    await cacheResponse(request, response.clone());
  }
  return response;
}

async function cacheResponse(request, response) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch (err) {
    console.warn('[SW] Cache put failed:', err);
  }
}

function refreshCache(request) {
  fetch(request)
    .then((response) => {
      if (response.ok) cacheResponse(request, response);
    })
    .catch(() => { /* silently fail */ });
}

// ── BACKGROUND SYNC (optional, future-ready) ──
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-loan-data') {
    console.log('[SW] Background sync triggered for loan data.');
    // Future: queue offline mutations and flush here
  }
});

// ── PUSH NOTIFICATIONS (future-ready) ──────────
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? { title: 'Lender Admin', body: 'You have a new notification.' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'lender-admin-push',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('index.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('./index.html');
    })
  );
});
