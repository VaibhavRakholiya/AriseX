const CACHE_NAME = 'flowboard-cache-v6';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './login.html',
  './styles.css',
  './firebase-rest-integration.js',
  './manifest.json',
  './js/state.js',
  './js/router.js',
  './js/projects.js',
  './js/agents.js',
  './js/chat.js',
  './js/dashboard.js',
  './js/tasks.js',
  './js/board.js',
  './js/speech-to-text.js',
  './js/reports.js',
  './js/timeline.js',
  './js/ui.js',
];

// Install Event - cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] Caching core assets');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate Event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache');
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Notification click — focus an already-open tab if there is one, otherwise
// open a new one. Without this, a notification shown via showNotification
// (TASK-648) just sits there when tapped on mobile, since there's no default
// "open the app" behavior for Service Worker notifications the way there is
// for the page-context Notification constructor on desktop.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
      const existing = clientsArr.find(c => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('./');
    })
  );
});

// Fetch Event - Network First with Cache Fallback strategy
self.addEventListener('fetch', event => {
  // Skip cross-origin requests, like those to Firebase
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // Network First Strategy. 'reload' forces revalidation with the server so
  // a stale browser HTTP-cache entry can't silently stand in for "network" —
  // that's how an old build (e.g. missing a new route) kept getting served
  // after a deploy even though this handler always tries the network first.
  event.respondWith(
    fetch(event.request, { cache: 'reload' })
      .then(networkResponse => {
        // Cache the latest version
        return caches.open(CACHE_NAME).then(cache => {
            // Only cache successful responses for GET requests
            if (event.request.method === 'GET' && networkResponse.ok) {
                cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
        });
      })
      .catch(() => {
        console.log('[Service Worker] Network request failed, returning cached fallback for', event.request.url);
        return caches.match(event.request);
      })
  );
});
