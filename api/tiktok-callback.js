// /api/tiktok-callback.js
// Retour du flux OAuth TikTok (voir tiktok-connect-start.js) : échange le
// code contre un jeton d'accès + de rafraîchissement, récupère le nom
// d'utilisateur, et enregistre la connexion.
//
// Variables d'environnement requises :
//   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, DASHBOARD_SESSION_SECRET,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { verifierEtatOAuth } from './_lib/oauth-state.js';

const SITE_BASE_URL = 'https://www.skyeco.fr';
const DASHBOARD_URL = `${SITE_BASE_URL}/mon-dashboard.html`;

function redirigerDashboard(res, draftId, statut) {
  res.writeHead(302, { Location: `${DASHBOARD_URL}?id=${encodeURIComponent(draftId)}&social=${statut}#reseaux` });
  res.end();
}

async function supabaseUpsertConnexion(draftId, champs) {
  const headersLecture = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
  const headersEcriture = { ...headersLecture, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  const existeResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?draft_id=eq.${draftId}&select=id`, { headers: headersLecture });
  const existe = existeResp.ok ? await existeResp.json() : [];
  if (existe.length) {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?draft_id=eq.${draftId}`, { method: 'PATCH', headers: headersEcriture, body: JSON.stringify(champs) });
  } else {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections`, { method: 'POST', headers: headersEcriture, body: JSON.stringify([{ draft_id: draftId, ...champs }]) });
  }
}

export default async function handler(req, res) {
  const { code, state, error: erreurTikTok } = req.query || {};

  const etat = state ? verifierEtatOAuth(state) : null;
  if (!etat) {
    return res.status(400).send('Lien de connexion invalide ou expiré — retournez sur votre dashboard et réessayez.');
  }
  const { draftId } = etat;

  if (erreurTikTok || !code) {
    return redirigerDashboard(res, draftId, 'tiktok_refuse');
  }

  try {
    const redirectUri = `${SITE_BASE_URL}/api/tiktok-callback`;
    const tokenResp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('tiktok-callback : échec échange code —', JSON.stringify(tokenData));
      return redirigerDashboard(res, draftId, 'tiktok_erreur');
    }

    let username = null;
    try {
      const infoResp = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=username', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const infoData = await infoResp.json();
      username = infoData?.data?.user?.username || null;
    } catch (e) {
      // Pas bloquant : on garde la connexion même sans le nom d'affichage.
    }

    await supabaseUpsertConnexion(draftId, {
      tiktok_open_id: tokenData.open_id,
      tiktok_username: username,
      tiktok_access_token: tokenData.access_token,
      tiktok_refresh_token: tokenData.refresh_token || null,
      tiktok_expires_at: new Date(Date.now() + (tokenData.expires_in || 86400) * 1000).toISOString(),
    });
    return redirigerDashboard(res, draftId, 'tiktok_succes');
  } catch (err) {
    console.error('Erreur tiktok-callback :', err);
    return redirigerDashboard(res, draftId, 'tiktok_erreur');
  }
}
