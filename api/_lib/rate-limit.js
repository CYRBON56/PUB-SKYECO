// api/_lib/rate-limit.js
// Limiteur de débit léger, en mémoire (sans dépendance externe) pour les
// endpoints publics sensibles (ex : envoi de SMS Twilio Verify).
// Limite : "au plus N tentatives pour une clé donnée, sur une fenêtre de W
// secondes".
//
// Portée : la mémoire est propre à CHAQUE instance de fonction serverless
// (elle est vidée au cold start, et n'est pas partagée entre plusieurs
// instances qui tournent en parallèle). C'est donc une protection best-effort
// et non une garantie absolue — mais elle bloque déjà l'abus le plus courant
// (spam répété sur la même instance chaude) sans ajouter de dépendance
// externe (base de données, Redis) ni de nouvelle variable d'environnement.
// Ce fichier manquait dans le dépôt, ce qui faisait planter (500) tout
// endpoint qui l'importe — d'où la panne d'envoi de SMS du 07/09.

const compteurs = new Map(); // clé -> { count, resetAt (timestamp ms) }

// Purge périodique pour éviter une fuite mémoire si l'instance reste chaude
// longtemps avec beaucoup de clés différentes.
function purgerExpires(maintenant) {
  for (const [cle, entree] of compteurs) {
    if (entree.resetAt <= maintenant) compteurs.delete(cle);
  }
}

/**
 * @param {string} cle - identifiant unique de la ressource limitée (ex: "verify-send-code:tel:+33...")
 * @param {number} maxTentatives - nombre de tentatives autorisées sur la fenêtre
 * @param {number} fenetreSecondes - durée de la fenêtre glissante, en secondes
 * @returns {Promise<boolean>} true si la tentative est autorisée, false si la limite est atteinte
 */
export async function verifierLimite(cle, maxTentatives, fenetreSecondes) {
  const maintenant = Date.now();
  if (compteurs.size > 5000) purgerExpires(maintenant); // garde-fou mémoire

  const entree = compteurs.get(cle);
  if (!entree || entree.resetAt <= maintenant) {
    compteurs.set(cle, { count: 1, resetAt: maintenant + fenetreSecondes * 1000 });
    return true;
  }
  if (entree.count >= maxTentatives) {
    return false;
  }
  entree.count += 1;
  return true;
}

/**
 * Extrait l'adresse IP du client depuis la requête (compatible Vercel :
 * x-forwarded-for peut contenir plusieurs IP séparées par des virgules,
 * la première est celle du client d'origine).
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
export function ipDepuisRequete(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) {
    const premiere = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
    if (premiere) return premiere;
  }
  const xReal = req.headers?.['x-real-ip'];
  if (xReal) return Array.isArray(xReal) ? xReal[0] : xReal;
  return req.socket?.remoteAddress || 'inconnu';
}
