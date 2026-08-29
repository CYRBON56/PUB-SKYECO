// /api/dashboard-admin-token.js
// Donne à Cyrille un accès direct au tableau de bord de n'importe quel
// artisan, SANS connaître son mot de passe — sur simple présentation du mot
// de passe interne déjà utilisé pour les pages d'admin (le même que
// verify-internal-password.js). Utilisé par le bouton "Accéder au
// dashboard" de mes-artisans.html.
//
// Le jeton renvoyé est volontairement de courte durée (10 minutes) car il
// transite dans une URL (donc potentiellement visible dans l'historique du
// navigateur) — largement suffisant pour ouvrir le dashboard et y rester
// ensuite (mon-dashboard.html ne revérifie pas en cours de session).
//
// Variable d'environnement requise : INTERNAL_ACCESS_PASSWORD, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

function signerToken(draftId, role, dureeSecondes) {
  const exp = Math.floor(Date.now() / 1000) + dureeSecondes;
  const payload = `${draftId}.${role}.${exp}`;
  const sig = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false });
  }
  const { draftId, motDePasseInterne } = req.body || {};
  if (!draftId || !motDePasseInterne) {
    return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
  }
  if (!process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(500).json({ success: false, error: 'Mot de passe interne non configuré côté serveur.' });
  }
  if (motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }

  const token = signerToken(draftId, 'admin', 60 * 10); // 10 minutes
  return res.status(200).json({ success: true, token });
}
