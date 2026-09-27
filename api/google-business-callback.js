// /api/google-business-callback.js
// Retour du flux OAuth Google Business Profile (voir
// google-business-connect-start.js) : échange le code contre un jeton,
// retrouve la fiche établissement (location) de l'artisan et enregistre la
// connexion.
//
// Variables d'environnement requises :
//   GOOGLE_BUSINESS_OAUTH_CLIENT_ID, GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET,
//   DASHBOARD_SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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
  const { code, state, error: erreurGoogle } = req.query || {};

  const etat = state ? verifierEtatOAuth(state) : null;
  if (!etat) {
    return res.status(400).send('Lien de connexion invalide ou expiré — retournez sur votre dashboard et réessayez.');
  }
  const { draftId } = etat;

  if (erreurGoogle || !code) {
    return redirigerDashboard(res, draftId, 'gbp_refuse');
  }

  try {
    const redirectUri = `${SITE_BASE_URL}/api/google-business-callback`;
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID,
        client_secret: process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('google-business-callback : échec échange code —', JSON.stringify(tokenData));
      return redirigerDashboard(res, draftId, 'gbp_erreur');
    }

    // 1. Compte(s) Business Profile de cet utilisateur Google.
    const comptesResp = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const comptesData = await comptesResp.json();
    const comptes = Array.isArray(comptesData.accounts) ? comptesData.accounts : [];
    if (!comptes.length) {
      return redirigerDashboard(res, draftId, 'gbp_sans_fiche');
    }
    const compte = comptes[0];

    // 2. Fiche(s) établissement de ce compte.
    const lieuxResp = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${compte.name}/locations?readMask=name,title`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const lieuxData = await lieuxResp.json();
    const lieux = Array.isArray(lieuxData.locations) ? lieuxData.locations : [];
    if (!lieux.length) {
      return redirigerDashboard(res, draftId, 'gbp_sans_fiche');
    }
    // Un artisan n'a en général qu'une seule fiche établissement.
    const lieu = lieux[0];

    await supabaseUpsertConnexion(draftId, {
      google_business_location_id: lieu.name, // ex: "locations/1234567890"
      google_business_location_name: lieu.title || null,
      google_business_access_token: tokenData.access_token,
      google_business_refresh_token: tokenData.refresh_token || null,
      google_business_expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
    });
    return redirigerDashboard(res, draftId, 'gbp_succes');
  } catch (err) {
    console.error('Erreur google-business-callback :', err);
    return redirigerDashboard(res, draftId, 'gbp_erreur');
  }
}
