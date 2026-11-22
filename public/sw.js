const CACHE = 'tsg-app-v3';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/tsg-logo.png', '/tsg-mark.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/src/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/node_modules/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Built files have a content hash in their name, so a cached copy is always
  // right. Keeping them lets the app open on site without a connection.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      // A file missing after a deploy comes back as the app page (HTML) on
      // Cloudflare; never store that under a script's name.
      const isPage = (response.headers.get('content-type') || '').includes('text/html');
      if (response.ok && !isPage) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); }
      return response;
    })));
    return;
  }

  if (url.pathname.startsWith('/icons/') || url.pathname === '/tsg-logo.png' || url.pathname === '/tsg-mark.png' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
