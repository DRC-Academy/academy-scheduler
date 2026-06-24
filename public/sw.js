const CACHE_NAME = 'drc-gestion-v1';

const STATIC_EXTENSIONS = [
  '.css', '.js', '.woff', '.woff2', '.ttf', '.otf', '.ico', '.png', '.jpg', '.jpeg', '.svg', '.webp',
];

function isStaticAsset(url) {
  const pathname = new URL(url).pathname;
  return STATIC_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

function isSupabaseRequest(url) {
  return url.includes('supabase.co');
}

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Never cache Supabase — always network-first, no cache fallback
  if (isSupabaseRequest(url)) {
    event.respondWith(fetch(request));
    return;
  }

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Cache-first for static assets
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(response => {
            if (response && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          });
        })
      )
    );
    return;
  }

  // Network-first for everything else (HTML, API routes, etc.)
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.status === 200 && request.destination === 'document') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
