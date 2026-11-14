self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin || e.request.headers.has('range') || /\.(mp4|webm)$/.test(new URL(e.request.url).pathname)) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open('cc-v2').then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
