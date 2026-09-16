// /sw.js — service worker minimal, rend mon-dashboard.html installable
// (Ajouter à l'écran d'accueil / PWA), met en cache uniquement les fichiers
// statiques (jamais les données live de l'API).
//
// IMPORTANT : ce fichier doit rester dans /public (servi tel quel, en JS
// statique) — un service worker placé sous /api serait exécuté comme une
// fonction serverless au lieu d'être servi comme fichier JS, et ne
// fonctionnerait pas du tout comme service worker.
//
// L'ancien fichier api/skyeco-service-worker.js (jamais réellement
// atteignable à la bonne URL depuis mon-dashboard.html, qui enregistre
// '/sw.js') reste dans le repo sans être utilisé — à supprimer un jour si
// Cyrille veut nettoyer, sans urgence.

const CACHE_NAME = "skyeco-pro-dashboard-v1";
const STATIC_ASSETS = [
  "/mon-dashboard.html",
  "/manifest.json",
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
