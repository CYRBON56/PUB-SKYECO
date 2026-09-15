// Service worker minimal — rend les deux dashboards installables
// et met en cache les fichiers statiques uniquement (jamais les données live de l'API).

const CACHE_NAME = "skyeco-ads-dashboards-v1";
const STATIC_ASSETS = [
  "/mon-dashboard.html",
  "/mes-artisans.html",
  "/manifest-dashboard.json",
  "/manifest-admin.json",
  "/icons/skyeco-icon-192.png",
  "/icons/skyeco-icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Ne JAMAIS mettre en cache les appels API (leads, sessions, RDV, coach IA, etc.)
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Réseau en priorité, cache en secours (utile si connexion faible sur chantier)
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
