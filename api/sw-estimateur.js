// /sw-estimateur.js — service worker minimal pour l'app "Estimateur BTP"
// (installable sur l'écran d'accueil), distinct du sw.js de Skyeco Pro.
//
// IMPORTANT : ce fichier doit rester dans /public (servi tel quel en JS
// statique) — un service worker placé sous /api serait exécuté comme une
// fonction serverless au lieu d'être servi comme fichier JS, et ne
// fonctionnerait pas du tout comme service worker.
//
// Le catalogue et le calculateur sont 100% embarqués dans estimateur-btp.html
// (aucun appel réseau/API requis pour fonctionner), donc ce SW se contente
// de mettre en cache le shell statique pour un usage hors-ligne sur chantier.

const CACHE_NAME = "estimateur-btp-v1";
const STATIC_ASSETS = [
  "/estimateur-btp.html",
  "/manifest-estimateur.json",
  "/icons/estimateur-btp-icon-192.png",
  "/icons/estimateur-btp-icon-512.png"
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

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Cache d'abord pour cette app : elle doit fonctionner sans réseau sur
  // un chantier isolé une fois installée (tout est déjà dans le HTML).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
