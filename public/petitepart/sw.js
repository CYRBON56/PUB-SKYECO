// Service worker de Petite Part : rend l'appli installable et affiche les rappels repas.
// Il ne met rien en cache : chaque ouverture charge la dernière version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Petite Part', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || "Petite Part", {
    body: d.body || "Qu'avez-vous mangé ?",
    icon: '/petitepart/icon-192.png', badge: '/petitepart/icon-192.png',
    tag: d.tag || 'pp-rappel', renotify: true, data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { w.postMessage({ moment: new URL(url).searchParams.get('moment') }); return w.focus(); } }
    return self.clients.openWindow(url);
  })());
});
