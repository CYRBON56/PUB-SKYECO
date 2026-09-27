// /api/_lib/oauth-state.js
// Signature du paramètre "state" des flux OAuth réseaux sociaux (Facebook,
// TikTok, Google Business Profile, Pinterest — 27/09/2026).
//
// Un flux OAuth redirige l'utilisateur vers la plateforme puis revient sur
// notre callback avec le "state" qu'on lui a donné au départ — c'est le SEUL
// moyen de savoir, au retour, à quel artisan (draftId) rattacher la
// connexion. Sans signature, n'importe qui pourrait forger un lien
// d'autorisation avec le draftId d'un AUTRE artisan (draftId non secret,
// visible dans les URL de vitrine) et lui voler la connexion d'un compte
// Facebook/TikTok/Google/Pinterest qui ne lui appartient pas. On signe donc
// le draftId + une expiration courte (10 min, largement suffisant pour un
// aller-retour OAuth) avec le même secret que les jetons de session du
// dashboard (DASHBOARD_SESSION_SECRET), même schéma HMAC que verifierToken
// ailleurs dans ce projet.
//
// Variable d'environnement requise : DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

const DUREE_VALIDITE_SECONDES = 10 * 60; // 10 minutes

export function creerEtatOAuth(draftId, retourExtra) {
  const exp = Math.floor(Date.now() / 1000) + DUREE_VALIDITE_SECONDES;
  const extra = retourExtra ? Buffer.from(String(retourExtra), 'utf8').toString('base64url') : '';
  const payload = `${draftId}.${exp}.${extra}`;
  const sig = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`, 'utf8').toString('base64url');
}

// Renvoie { draftId, extra } si le state est valide et non expiré, sinon null.
export function verifierEtatOAuth(state) {
  try {
    const decode = Buffer.from(state, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return null;
    const [draftId, expStr, extraB64, sig] = parties;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return null;

    const payload = `${draftId}.${expStr}.${extraB64}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return null;

    const extra = extraB64 ? Buffer.from(extraB64, 'base64url').toString('utf8') : null;
    return { draftId, extra };
  } catch (e) {
    return null;
  }
}
