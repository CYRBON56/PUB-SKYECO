// /api/dashboard-verify-session.js
// Vérifie qu'un jeton de session (artisan connecté normalement, OU accès
// admin depuis mes-artisans.html) est valide pour CE draftId précis, avant
// de laisser mon-dashboard.html afficher les données.
//
// Variable d'environnement requise : DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

function verifierToken(token, draftIdAttendu) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return null;
    const [draftId, role, expStr, sig] = parties;
    if (draftId !== draftIdAttendu) return null;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return null;

    const payload = `${draftId}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return null;

    return { draftId, role };
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false });
  }
  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(400).json({ valid: false });
  }

  const resultat = verifierToken(token, draftId);
  if (!resultat) {
    return res.status(401).json({ valid: false });
  }
  return res.status(200).json({ valid: true, role: resultat.role });
}
