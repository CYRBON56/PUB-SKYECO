// /api/facebook-callback.js
// Reçoit le retour du dialogue OAuth Facebook classique (voir
// facebook-connect-start.js) : échange le code contre un jeton utilisateur,
// le transforme en jeton longue durée, puis récupère la (les) Page(s)
// Facebook administrée(s) par l'utilisateur et le jeton de Page associé.
//
// S'il y a plusieurs Pages, on connecte la première renvoyée par Meta —
// cas rare pour un artisan, à faire évoluer plus tard avec un sélecteur si
// besoin.
//
// Variables d'environnement requises :
//   FACEBOOK_APP_ID
//   FACEBOOK_APP_SECRET     - "Clé secrète" de l'app (Paramètres > Basique) ;
//                              différente de INSTAGRAM_APP_SECRET.
//   FACEBOOK_REDIRECT_URI   - identique à celle de facebook-connect-start.js
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Colonnes Supabase attendues (ajoutées le 13/09 sur la table existante) :
//   alter table skyeco_pro_social_connections
//     add column facebook_page_id text,
//     add column facebook_page_name text,
//     add column facebook_access_token text;

export default async function handler(req, res) {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    const draftId = decodeState(state)?.draftId;
    redirectToDashboard(res, draftId, "fb_refuse");
    return;
  }

  const decoded = decodeState(state);
  if (!decoded || !decoded.draftId) {
    res.status(400).send("État OAuth invalide.");
    return;
  }
  const { draftId } = decoded;

  const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
  const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
  const FACEBOOK_REDIRECT_URI = process.env.FACEBOOK_REDIRECT_URI;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // 1. Échanger le code contre un jeton utilisateur courte durée.
    const shortRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
        `?client_id=${encodeURIComponent(FACEBOOK_APP_ID)}` +
        `&client_secret=${encodeURIComponent(FACEBOOK_APP_SECRET)}` +
        `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}` +
        `&code=${encodeURIComponent(code)}`
    );
    const shortData = await shortRes.json();
    if (!shortData.access_token) {
      throw new Error("Échange du code OAuth Facebook échoué : " + JSON.stringify(shortData));
    }

    // 2. Échanger contre un jeton utilisateur longue durée (~60 jours) — les
    // jetons de Page qu'on en tire ensuite n'expirent en pratique pas tant
    // que ce jeton utilisateur reste valide.
    const longRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
        `?grant_type=fb_exchange_token` +
        `&client_id=${encodeURIComponent(FACEBOOK_APP_ID)}` +
        `&client_secret=${encodeURIComponent(FACEBOOK_APP_SECRET)}` +
        `&fb_exchange_token=${encodeURIComponent(shortData.access_token)}`
    );
    const longData = await longRes.json();
    const userToken = longData.access_token || shortData.access_token;

    // 3. Lister les Pages administrées par l'utilisateur (+ jeton de Page).
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts` +
        `?fields=id,name,access_token` +
        `&access_token=${encodeURIComponent(userToken)}`
    );
    const pagesData = await pagesRes.json();
    const pages = pagesData.data || [];

    if (!pages.length) {
      redirectToDashboard(res, draftId, "fb_sans_page");
      return;
    }

    const page = pages[0]; // une seule Page pour un artisan, dans l'immense majorité des cas

    // 4. Enregistrer la connexion Facebook (upsert partiel sur draft_id —
    // ne touche pas aux colonnes Instagram déjà présentes sur la ligne).
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
          facebook_page_id: page.id,
          facebook_page_name: page.name || null,
          facebook_access_token: page.access_token,
        }),
      }
    );
    if (!upsertRes.ok) {
      throw new Error("Échec de l'enregistrement Supabase (Facebook) : " + (await upsertRes.text()));
    }

    redirectToDashboard(res, draftId, "fb_succes");
  } catch (e) {
    console.error("Erreur facebook-callback:", e);
    redirectToDashboard(res, draftId, "fb_erreur");
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
