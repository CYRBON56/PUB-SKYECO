// Service worker minimal de Petite Part : rend l'appli installable.
// Il ne met rien en cache : chaque ouverture charge la dernière version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
