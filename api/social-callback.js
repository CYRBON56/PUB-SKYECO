// /api/social-callback.js
// Reçoit le retour du flux "Instagram Login" (voir social-connect-start.js).
// Contrairement au flux via Page Facebook, ce flux donne directement un
// compte Instagram Business/Creator — pas de Page à chercher.
//
// Variables d'environnement requises :
//   INSTAGRAM_APP_ID
//   INSTAGRAM_APP_SECRET     - "Clé secrète Instagram" (même écran que l'App ID)
//   INSTAGRAM_REDIRECT_URI   - identique à celle de social-connect-start.js
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Table Supabase attendue (identique à avant, mais page_id devient optionnel) :
//   create table skyeco_pro_social_connections (
//     id uuid primary key default gen_random_uuid(),
//     draft_id uuid not null references skyeco_pro_vitrine_drafts(id),
//     page_id text,                        -- non utilisé avec ce flux, peut rester vide
//     ig_business_account_id text not null,  -- ici : le user_id Instagram retourné
//     ig_username text,
//     access_token text not null,           -- long-lived Instagram User token
//     expires_at timestamptz,
//     created_at timestamptz default now(),
//     unique(draft_id)
//   );

export default async function handler(req, res) {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    const draftId = decodeState(state)?.draftId;
    redirectToDashboard(res, draftId, "refuse");
    return;
  }

  const decoded = decodeState(state);
  if (!decoded || !decoded.draftId) {
    res.status(400).send("État OAuth invalide.");
    return;
  }
  const { draftId } = decoded;

  const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
  const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
  const INSTAGRAM_REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // 1. Échanger le code contre un token courte durée (Instagram Login,
    // et non graph.facebook.com — endpoint différent du flux Page Facebook).
    const params = new URLSearchParams({
      client_id: INSTAGRAM_APP_ID,
      client_secret: INSTAGRAM_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: INSTAGRAM_REDIRECT_URI,
      code,
    });
    const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const shortData = await shortRes.json();
    if (!shortData.access_token) {
      throw new Error("Échange du code OAuth échoué : " + JSON.stringify(shortData));
    }
    const igUserId = shortData.user_id;

    // 2. Échanger contre un token longue durée (~60 jours).
    const longRes = await fetch(
      `https://graph.instagram.com/access_token` +
        `?grant_type=ig_exchange_token` +
        `&client_secret=${encodeURIComponent(INSTAGRAM_APP_SECRET)}` +
        `&access_token=${encodeURIComponent(shortData.access_token)}`
    );
    const longData = await longRes.json();
    const accessToken = longData.access_token || shortData.access_token;
    const expiresInSec = longData.expires_in || 60 * 24 * 60 * 60; // repli 60 jours

    // 3. Récupérer le nom d'utilisateur pour l'affichage.
    const meRes = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=username&access_token=${encodeURIComponent(accessToken)}`
    );
    const meData = await meRes.json();

    // 4. Enregistrer la connexion (upsert sur draft_id).
    const expiresAt = new Date(Date.now() + (expiresInSec - 5 * 24 * 60 * 60) * 1000).toISOString(); // marge de 5 jours
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
          page_id: null,
          ig_business_account_id: igUserId,
          ig_username: meData.username || null,
          access_token: accessToken,
          expires_at: expiresAt,
        }),
      }
    );
    if (!upsertRes.ok) {
      throw new Error("Échec de l'enregistrement Supabase : " + (await upsertRes.text()));
    }

    redirectToDashboard(res, draftId, "succes");
  } catch (e) {
    console.error("Erreur social-callback:", e);
    redirectToDashboard(res, draftId, "erreur");
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
