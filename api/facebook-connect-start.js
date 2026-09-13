// /api/facebook-connect-start.js
// Démarre le flux "Se connecter avec Facebook" (dialogue OAuth classique par
// scopes) pour relier la Page Facebook professionnelle de l'artisan, en plus
// d'Instagram (voir social-connect-start.js pour le flux Instagram Login).
//
// On utilise ici le dialogue OAuth classique (scope=...) plutôt que le
// flux "Facebook Login for Business" basé sur config_id : il donne le même
// résultat (jeton utilisateur -> /me/accounts -> jetons de Page) sans obliger
// Cyrille à créer une "Configuration" dans le dashboard Meta au préalable.
//
// Variables d'environnement requises :
//   FACEBOOK_APP_ID        - ID de l'app Meta (Paramètres de l'app > Basique)
//   FACEBOOK_REDIRECT_URI  - ex: https://skyeco.fr/api/facebook-callback
//                             (à ajouter dans Facebook Login > Paramètres >
//                             "URI de redirection OAuth valides")

export default function handler(req, res) {
  const { id: draftId, token } = req.query;

  if (!draftId) {
    res.status(400).send("Paramètre 'id' manquant.");
    return;
  }

  const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
  const FACEBOOK_REDIRECT_URI = process.env.FACEBOOK_REDIRECT_URI;

  if (!FACEBOOK_APP_ID || !FACEBOOK_REDIRECT_URI) {
    res.status(500).send("Configuration Facebook manquante côté serveur (FACEBOOK_APP_ID / FACEBOOK_REDIRECT_URI).");
    return;
  }

  const state = Buffer.from(JSON.stringify({ draftId, token })).toString("base64url");

  // Permissions nécessaires pour lister les Pages de l'utilisateur et
  // publier des photos/vidéos sur la Page choisie.
  const scopes = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
  ].join(",");

  const authUrl =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${encodeURIComponent(FACEBOOK_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scopes)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}
