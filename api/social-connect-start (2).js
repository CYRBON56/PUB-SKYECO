// /api/social-connect-start.js
// Démarre le flux "Instagram API avec connexion Instagram" (Instagram Login
// direct) — pas besoin de Page Facebook liée avec cette approche.
//
// Variables d'environnement requises :
//   INSTAGRAM_APP_ID        - "ID d'app Instagram" (Configuration de l'API avec
//                              la connexion Instagram), ex: 212266338148870
//   INSTAGRAM_REDIRECT_URI  - ex: https://skyeco.fr/api/social-callback

export default function handler(req, res) {
  const { id: draftId, token } = req.query;

  if (!draftId) {
    res.status(400).send("Paramètre 'id' manquant.");
    return;
  }

  const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
  const INSTAGRAM_REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI;

  if (!INSTAGRAM_APP_ID || !INSTAGRAM_REDIRECT_URI) {
    res.status(500).send("Configuration Instagram manquante côté serveur (INSTAGRAM_APP_ID / INSTAGRAM_REDIRECT_URI).");
    return;
  }

  const state = Buffer.from(JSON.stringify({ draftId, token })).toString("base64url");

  // Scopes du flux "Instagram Login" (différents de ceux du flux Facebook Login) :
  const scopes = [
    "instagram_business_basic",
    "instagram_business_content_publish",
    "instagram_business_manage_comments",
    "instagram_business_manage_messages",
  ].join(",");

  const authUrl =
    `https://www.instagram.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(INSTAGRAM_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(INSTAGRAM_REDIRECT_URI)}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scopes)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}
