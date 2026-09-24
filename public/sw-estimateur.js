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
//
// BUG CORRIGÉ LE 24/09/2026 — c'était la vraie cause des mises à jour qui
// "n'arrivaient jamais" sur le téléphone de Cyrille (plusieurs correctifs de
// suite sans effet visible) :
//   1) CACHE_NAME était fixe ("v1"), jamais changé d'un déploiement à
//      l'autre → "activate" ne supprimait donc jamais l'ancien cache.
//   2) La stratégie était "cache d'abord" (on servait TOUJOURS la version
//      en cache, même avec du réseau disponible, et on ne rafraîchissait le
//      cache qu'en tâche de fond, invisible tant que la page n'est pas
//      rechargée une SECONDE fois après le déploiement).
// Résultat : après avoir mis en ligne un correctif, il fallait ouvrir l'appli
// deux fois (la 1ère pour rafraîchir le cache en coulisses, la 2e pour voir
// le changement) — et si le test se faisait hors connexion (le cas d'usage
// même de cette appli), le cache ne se mettait jamais à jour du tout.
// Correction : CACHE_NAME inclut un numéro de version à incrémenter à
// chaque déploiement qui change le HTML/les assets ; et la stratégie passe
// à "réseau d'abord, cache en secours seulement si hors-ligne" — l'app reste
// utilisable sans réseau sur un chantier isolé, mais dès qu'il y a du
// réseau, c'est toujours la dernière version qui s'affiche.
const CACHE_VERSION = "v2"; // ⚠️ à incrémenter à chaque déploiement touchant cette appli
const CACHE_NAME = "estimateur-btp-" + CACHE_VERSION;
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

  // Réseau d'abord : dès qu'il y a du réseau, on affiche toujours la
  // dernière version déployée (et on la met en cache au passage). Le cache
  // ne sert que de secours quand il n'y a pas de réseau — le vrai besoin
  // de cette appli sur un chantier isolé.
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
