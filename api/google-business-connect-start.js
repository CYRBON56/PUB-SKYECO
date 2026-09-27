// /api/google-business-connect-start.js
// Démarre le flux OAuth Google (Business Profile API, 27/09/2026) pour que
// l'agent IA puisse publier automatiquement des posts sur la fiche
// Google Business Profile (Google Maps / Google Search) de l'artisan —
// le réseau le plus utile pour un artisan local.
//
// GET ?id=<draftId>&token=<jeton de session dashboard>
//   -> redirige vers l'écran de consentement Google.
//
// Variables d'environnement requises :
//   GOOGLE_BUSINESS_OAUTH_CLIENT_ID, DASHBOARD_SESSION_SECRET, SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY
//
// Pré-requis côté Google (à faire une fois, dans console.cloud.google.com) :
//   - Activer "My Business Business Information API" et
//     "My Business Account Management API" sur le projet.
//   - IMPORTANT : l'accès à ces API n'est pas automatique — Google demande
//     de remplir un formulaire de demande d'accès (Business Profile API
//     access request) ; le délai d'approbation n'est pas garanti, à lancer
//     le plus tôt possible.
//   - Écran de consentement OAuth configuré, avec le scope
//     https://www.googleapis.com/auth/business.manage.
//   - URI de redirection autorisée :
//     https://www.skyeco.fr/api/google-business-callback

import crypto from 'crypto';
import { creerEtatOAuth } from './_lib/oauth-state.js';

function verifierToken(token, draftIdAttendu) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return false;
    const [sujet, role, expStr, sig] = parties;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return false;
    const payload = `${sujet}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return false;
    return role === 'admin' ? sujet === draftIdAttendu : role === 'artisan';
  } catch (e) {
    return false;
  }
}

const SITE_BASE_URL = 'https://www.skyeco.fr';

export default async function handler(req, res) {
  const draftId = req.query?.id;
  const token = req.query?.token;
  if (!draftId || !token || !verifierToken(token, draftId)) {
    return res.status(401).send('Session invalide — retournez sur votre dashboard et réessayez.');
  }
  if (!process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID) {
    return res.status(500).send('Configuration serveur incomplète (GOOGLE_BUSINESS_OAUTH_CLIENT_ID manquant) — contactez le support.');
  }

  const state = creerEtatOAuth(draftId);
  const redirectUri = `${SITE_BASE_URL}/api/google-business-callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/business.manage');
  url.searchParams.set('access_type', 'offline'); // pour obtenir un refresh_token
  url.searchParams.set('prompt', 'consent'); // force le refresh_token même en reconnexion
  url.searchParams.set('state', state);

  res.writeHead(302, { Location: url.toString() });
  res.end();
}
