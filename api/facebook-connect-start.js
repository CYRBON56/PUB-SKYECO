// /api/facebook-connect-start.js
// Démarre le flux OAuth Facebook Login for Business (27/09/2026) — connecte
// à la fois la Page Facebook ET son compte Instagram professionnel relié
// (une seule autorisation Meta pour les deux réseaux), pour que l'agent IA
// puisse ensuite publier automatiquement sur les deux.
//
// GET ?id=<draftId>&token=<jeton de session dashboard>
//   -> redirige vers la boîte de dialogue d'autorisation Facebook.
//
// Variables d'environnement requises :
//   META_APP_ID, DASHBOARD_SESSION_SECRET, SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY
//
// Pré-requis côté Meta (à faire une fois, dans developers.facebook.com) :
//   - Une app Meta en mode "Live" (pas juste "Development") pour que
//     n'importe quel artisan (pas seulement les comptes testeurs de l'app)
//     puisse se connecter.
//   - Produit "Facebook Login for Business" ajouté à l'app.
//   - URI de redirection autorisée : https://www.skyeco.fr/api/facebook-callback
//   - Permissions à demander en App Review (sinon seuls les comptes
//     testeurs/admin de l'app fonctionnent) : pages_show_list,
//     pages_manage_posts, pages_read_engagement, instagram_basic,
//     instagram_content_publish, business_management.

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
const SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
].join(',');

export default async function handler(req, res) {
  const draftId = req.query?.id;
  const token = req.query?.token;
  if (!draftId || !token || !verifierToken(token, draftId)) {
    return res.status(401).send('Session invalide — retournez sur votre dashboard et réessayez.');
  }
  if (!process.env.META_APP_ID) {
    return res.status(500).send("Configuration serveur incomplète (META_APP_ID manquant) — contactez le support.");
  }

  const state = creerEtatOAuth(draftId);
  const redirectUri = `${SITE_BASE_URL}/api/facebook-callback`;
  const url = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('response_type', 'code');

  res.writeHead(302, { Location: url.toString() });
  res.end();
}
