// Service worker de l'espace commercial Skyeco (/freelance/).
// Réseau d'abord (données toujours à jour), page gardée en cache pour s'ouvrir hors connexion.
const CACHE = 'skyeco-freelance-v1';
const COQUILLE = ['/freelance/', '/freelance/mon-assistant-pro.html', '/icons/skyeco-icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(COQUILLE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.endsWith('.mp4')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(u.pathname === '/freelance/index.html' ? '/freelance/' : e.request, copie)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/freelance/'))));
});
