// /api/pinterest-connect-start.js
// Démarre le flux OAuth Pinterest (27/09/2026) pour que l'agent IA puisse
// publier automatiquement des épingles (photos de réalisations) sur le
// compte Pinterest de l'artisan.
//
// GET ?id=<draftId>&token=<jeton de session dashboard>
//   -> redirige vers la boîte de dialogue d'autorisation Pinterest.
//
// Variables d'environnement requises :
//   PINTEREST_APP_ID, DASHBOARD_SESSION_SECRET, SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY
//
// Pré-requis côté Pinterest (à faire une fois, dans developers.pinterest.com) :
//   - Une app Pinterest passée en "Standard access" (le niveau "Trial"
//     limite fortement les appels et n'autorise que les comptes testeurs
//     déclarés) — la demande de passage en Standard access est à lancer tôt.
//   - URI de redirection autorisée : https://www.skyeco.fr/api/pinterest-callback
//   - Scopes activés sur l'app : boards:read, boards:write, pins:read,
//     pins:write, user_accounts:read.

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
const SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'].join(',');

export default async function handler(req, res) {
  const draftId = req.query?.id;
  const token = req.query?.token;
  if (!draftId || !token || !verifierToken(token, draftId)) {
    return res.status(401).send('Session invalide — retournez sur votre dashboard et réessayez.');
  }
  if (!process.env.PINTEREST_APP_ID) {
    return res.status(500).send('Configuration serveur incomplète (PINTEREST_APP_ID manquant) — contactez le support.');
  }

  const state = creerEtatOAuth(draftId);
  const redirectUri = `${SITE_BASE_URL}/api/pinterest-callback`;
  const url = new URL('https://www.pinterest.com/oauth/');
  url.searchParams.set('client_id', process.env.PINTEREST_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);

  res.writeHead(302, { Location: url.toString() });
  res.end();
}
