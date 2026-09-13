// /api/tiktok-connect-start.js
// Démarre le flux OAuth TikTok ("Login Kit") pour connecter le compte TikTok
// de l'artisan, en plus d'Instagram/Facebook/Google Business Profile.
// Contrairement à Google Business Profile (connexion admin-mediée via
// Windsor.ai), TikTok est bien un OAuth self-service depuis le dashboard,
// comme Instagram et Facebook.
//
// ⚠️ Limite TikTok à connaître (voir tiktok-callback.js et social-publish.js) :
// tant que l'app TikTok de Cyrille n'a pas passé l'audit "Content Posting
// API", tous les posts publiés seront forcés en privé (SELF_ONLY), quel que
// soit le réglage demandé — l'audit ne conditionne pas l'usage de l'API,
// seulement la visibilité publique des posts.
//
// Variables d'environnement requises :
//   TIKTOK_CLIENT_KEY     - "Client key" de l'app TikTok for Developers
//   TIKTOK_REDIRECT_URI   - ex: https://skyeco.fr/api/tiktok-callback
//                            (à enregistrer dans TikTok for Developers >
//                            Login Kit > Redirect URI)

export default function handler(req, res) {
  const { id: draftId, token } = req.query;

  if (!draftId) {
    res.status(400).send("Paramètre 'id' manquant.");
    return;
  }

  const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
  const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;

  if (!TIKTOK_CLIENT_KEY || !TIKTOK_REDIRECT_URI) {
    res.status(500).send("Configuration TikTok manquante côté serveur (TIKTOK_CLIENT_KEY / TIKTOK_REDIRECT_URI).");
    return;
  }

  const state = Buffer.from(JSON.stringify({ draftId, token })).toString("base64url");

  // video.publish est indispensable pour publier via le Content Posting API ;
  // user.info.basic permet de récupérer le nom d'utilisateur pour l'affichage.
  const scopes = ["user.info.basic", "video.publish"].join(",");

  const authUrl =
    `https://www.tiktok.com/v2/auth/authorize/` +
    `?client_key=${encodeURIComponent(TIKTOK_CLIENT_KEY)}` +
    `&redirect_uri=${encodeURIComponent(TIKTOK_REDIRECT_URI)}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scopes)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}
