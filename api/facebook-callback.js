// /api/facebook-callback.js
// Retour du flux OAuth Facebook Login for Business (voir
// facebook-connect-start.js) : échange le code contre un jeton, récupère la
// Page Facebook de l'artisan et, si elle en a un, son compte Instagram
// professionnel relié — une seule connexion Meta pour les deux réseaux.
//
// Variables d'environnement requises :
//   META_APP_ID, META_APP_SECRET, DASHBOARD_SESSION_SECRET, SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY

import { verifierEtatOAuth } from './_lib/oauth-state.js';

const SITE_BASE_URL = 'https://www.skyeco.fr';
const DASHBOARD_URL = `${SITE_BASE_URL}/mon-dashboard.html`;

function redirigerDashboard(res, draftId, statut) {
  res.writeHead(302, { Location: `${DASHBOARD_URL}?id=${encodeURIComponent(draftId)}&social=${statut}#reseaux` });
  res.end();
}

async function supabaseUpsertConnexion(draftId, champs) {
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  const existeResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?draft_id=eq.${draftId}&select=id`,
    { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const existe = existeResp.ok ? await existeResp.json() : [];
  if (existe.length) {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?draft_id=eq.${draftId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(champs),
    });
  } else {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ draft_id: draftId, ...champs }]),
    });
  }
}

export default async function handler(req, res) {
  const { code, state, error: erreurMeta } = req.query || {};

  const etat = state ? verifierEtatOAuth(state) : null;
  if (!etat) {
    // Sans draftId fiable on ne peut même pas rediriger vers le bon
    // dashboard — state absent/expiré/forgé.
    return res.status(400).send("Lien de connexion invalide ou expiré — retournez sur votre dashboard et réessayez.");
  }
  const { draftId } = etat;

  if (erreurMeta || !code) {
    return redirigerDashboard(res, draftId, 'fb_refuse');
  }

  try {
    const redirectUri = `${SITE_BASE_URL}/api/facebook-callback`;

    // 1. Code -> jeton utilisateur courte durée.
    const tokenUrl = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
    tokenUrl.searchParams.set('client_id', process.env.META_APP_ID);
    tokenUrl.searchParams.set('client_secret', process.env.META_APP_SECRET);
    tokenUrl.searchParams.set('redirect_uri', redirectUri);
    tokenUrl.searchParams.set('code', code);
    const tokenResp = await fetch(tokenUrl.toString());
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('facebook-callback : échec échange code —', JSON.stringify(tokenData));
      return redirigerDashboard(res, draftId, 'fb_erreur');
    }

    // 2. Jeton utilisateur courte durée -> longue durée (~60 jours).
    const echangeUrl = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
    echangeUrl.searchParams.set('grant_type', 'fb_exchange_token');
    echangeUrl.searchParams.set('client_id', process.env.META_APP_ID);
    echangeUrl.searchParams.set('client_secret', process.env.META_APP_SECRET);
    echangeUrl.searchParams.set('fb_exchange_token', tokenData.access_token);
    const echangeResp = await fetch(echangeUrl.toString());
    const echangeData = await echangeResp.json();
    const jetonUtilisateurLong = echangeResp.ok && echangeData.access_token ? echangeData.access_token : tokenData.access_token;

    // 3. Liste des Pages gérées par cet utilisateur.
    const pagesResp = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(jetonUtilisateurLong)}`
    );
    const pagesData = await pagesResp.json();
    const pages = Array.isArray(pagesData.data) ? pagesData.data : [];
    if (!pages.length) {
      return redirigerDashboard(res, draftId, 'fb_sans_page');
    }
    // Un artisan n'a en général qu'une seule Page — on prend la première.
    // (Amélioration possible plus tard : écran de choix si plusieurs Pages.)
    const page = pages[0];

    const champs = {
      facebook_page_id: page.id,
      facebook_page_name: page.name || null,
      facebook_access_token: page.access_token, // jeton de Page : n'expire pas tant que le jeton utilisateur reste valide
    };
    if (page.instagram_business_account && page.instagram_business_account.id) {
      champs.ig_business_account_id = page.instagram_business_account.id;
      champs.ig_username = page.instagram_business_account.username || null;
      champs.access_token = page.access_token; // Graph API Instagram utilise le même jeton de Page
    }

    await supabaseUpsertConnexion(draftId, champs);
    return redirigerDashboard(res, draftId, 'fb_succes');
  } catch (err) {
    console.error('Erreur facebook-callback :', err);
    return redirigerDashboard(res, draftId, 'fb_erreur');
  }
}
