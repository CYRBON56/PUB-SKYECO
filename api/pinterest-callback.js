// /api/pinterest-callback.js
// Retour du flux OAuth Pinterest (voir pinterest-connect-start.js) :
// échange le code contre un jeton, retrouve (ou crée) un tableau
// ("board") pour les réalisations de l'artisan, et enregistre la connexion.
//
// Variables d'environnement requises :
//   PINTEREST_APP_ID, PINTEREST_APP_SECRET, DASHBOARD_SESSION_SECRET,
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
  const { code, state, error: erreurPinterest } = req.query || {};

  const etat = state ? verifierEtatOAuth(state) : null;
  if (!etat) {
    return res.status(400).send('Lien de connexion invalide ou expiré — retournez sur votre dashboard et réessayez.');
  }
  const { draftId } = etat;

  if (erreurPinterest || !code) {
    return redirigerDashboard(res, draftId, 'pinterest_refuse');
  }

  try {
    const redirectUri = `${SITE_BASE_URL}/api/pinterest-callback`;
    const identifiants = Buffer.from(`${process.env.PINTEREST_APP_ID}:${process.env.PINTEREST_APP_SECRET}`).toString('base64');
    const tokenResp = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${identifiants}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('pinterest-callback : échec échange code —', JSON.stringify(tokenData));
      return redirigerDashboard(res, draftId, 'pinterest_erreur');
    }

    const utilisateurResp = await fetch('https://api.pinterest.com/v5/user_account', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const utilisateurData = await utilisateurResp.json();

    // Tableau existant, sinon on en crée un par défaut pour les réalisations.
    let boardId = null;
    let boardName = null;
    const boardsResp = await fetch('https://api.pinterest.com/v5/boards?page_size=1', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const boardsData = await boardsResp.json();
    const boards = Array.isArray(boardsData.items) ? boardsData.items : [];
    if (boards.length) {
      boardId = boards[0].id;
      boardName = boards[0].name;
    } else {
      const creationResp = await fetch('https://api.pinterest.com/v5/boards', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nos réalisations', description: 'Chantiers et réalisations récentes.' }),
      });
      const creationData = await creationResp.json();
      if (creationResp.ok && creationData.id) {
        boardId = creationData.id;
        boardName = creationData.name;
      }
    }

    await supabaseUpsertConnexion(draftId, {
      pinterest_user_id: utilisateurData?.username || null,
      pinterest_username: utilisateurData?.username || null,
      pinterest_board_id: boardId,
      pinterest_board_name: boardName,
      pinterest_access_token: tokenData.access_token,
      pinterest_refresh_token: tokenData.refresh_token || null,
      pinterest_expires_at: new Date(Date.now() + (tokenData.expires_in || 2592000) * 1000).toISOString(),
    });
    return redirigerDashboard(res, draftId, 'pinterest_succes');
  } catch (err) {
    console.error('Erreur pinterest-callback :', err);
    return redirigerDashboard(res, draftId, 'pinterest_erreur');
  }
}
