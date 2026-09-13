// /api/tiktok-callback.js
// Reçoit le retour du flux OAuth TikTok (voir tiktok-connect-start.js) :
// échange le code contre un access_token (durée de vie courte, 24h) et un
// refresh_token (durée de vie longue, 365 jours), puis enregistre la
// connexion. Le rafraîchissement du token avant chaque publication est géré
// dans social-publish.js (publierSurTikTokSiConnecte), pas ici.
//
// Variables d'environnement requises :
//   TIKTOK_CLIENT_KEY
//   TIKTOK_CLIENT_SECRET
//   TIKTOK_REDIRECT_URI     - identique à celle de tiktok-connect-start.js
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Colonnes Supabase attendues (ajoutées le 13/09) :
//   alter table skyeco_pro_social_connections
//     add column tiktok_open_id text,
//     add column tiktok_username text,
//     add column tiktok_access_token text,
//     add column tiktok_refresh_token text,
//     add column tiktok_expires_at timestamptz;

export default async function handler(req, res) {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    const draftId = decodeState(state)?.draftId;
    redirectToDashboard(res, draftId, "tiktok_refuse");
    return;
  }

  const decoded = decodeState(state);
  if (!decoded || !decoded.draftId) {
    res.status(400).send("État OAuth invalide.");
    return;
  }
  const { draftId } = decoded;

  const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
  const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
  const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // 1. Échanger le code contre un access_token + refresh_token. Le code
    // renvoyé par TikTok peut contenir des caractères encodés — on le
    // décode avant l'échange, comme recommandé par la doc officielle.
    const codeNettoye = typeof code === "string" ? decodeURIComponent(code) : code;

    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code: codeNettoye,
        grant_type: "authorization_code",
        redirect_uri: TIKTOK_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error("Échange du code OAuth TikTok échoué : " + JSON.stringify(tokenData));
    }

    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresInSec,
      open_id: openId,
    } = tokenData;

    // 2. Récupérer le nom d'utilisateur pour l'affichage.
    let username = null;
    try {
      const meRes = await fetch(
        "https://open.tiktokapis.com/v2/user/info/?fields=display_name",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const meData = await meRes.json();
      username = meData?.data?.user?.display_name || null;
    } catch (e) {
      // Non bloquant : l'absence de username n'empêche pas la connexion.
    }

    // 3. Enregistrer la connexion (upsert partiel sur draft_id — ne touche
    // pas aux colonnes Instagram/Facebook/Google déjà présentes).
    const expiresAt = new Date(Date.now() + (expiresInSec - 60 * 30) * 1000).toISOString(); // marge de 30 min
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?on_conflict=draft_id`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          draft_id: draftId,
          tiktok_open_id: openId,
          tiktok_username: username,
          tiktok_access_token: accessToken,
          tiktok_refresh_token: refreshToken,
          tiktok_expires_at: expiresAt,
        }),
      }
    );
    if (!upsertRes.ok) {
      throw new Error("Échec de l'enregistrement Supabase (TikTok) : " + (await upsertRes.text()));
    }

    redirectToDashboard(res, draftId, "tiktok_succes");
  } catch (e) {
    console.error("Erreur tiktok-callback:", e);
    redirectToDashboard(res, draftId, "tiktok_erreur");
  }
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
  } catch (e) {
    return null;
  }
}

function redirectToDashboard(res, draftId, statut) {
  const url = `/mon-dashboard.html?id=${encodeURIComponent(draftId || "")}&social=${statut}#reseaux`;
  res.writeHead(302, { Location: url });
  res.end();
}
