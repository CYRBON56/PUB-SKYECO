// /api/dashboard-reset-password.js
// Étape finale du "mot de passe oublié" : vérifie le jeton reçu par
// SMS/email (dashboard-forgot-password.js) puis enregistre le nouveau mot
// de passe. Reconnecte directement l'artisan (jeton de session renvoyé).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

function hasherMotDePasse(motDePasse) {
  const sel = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(motDePasse, sel, 64).toString('hex');
  return `${sel}:${hash}`;
}

function signerToken(draftId, role, dureeSecondes) {
  const exp = Math.floor(Date.now() / 1000) + dureeSecondes;
  const payload = `${draftId}.${role}.${exp}`;
  const sig = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  const { draftId, token, nouveauMotDePasse } = req.body || {};
  if (!draftId || !token || !nouveauMotDePasse) {
    return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
  }
  if (nouveauMotDePasse.length < 8) {
    return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=dashboard_reset_token,dashboard_reset_token_expire`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();
    const draft = rows[0];

    if (!draft || !draft.dashboard_reset_token || draft.dashboard_reset_token !== token) {
      return res.status(403).json({ success: false, error: 'Ce lien de réinitialisation est invalide.' });
    }
    if (!draft.dashboard_reset_token_expire || new Date(draft.dashboard_reset_token_expire) < new Date()) {
      return res.status(403).json({ success: false, error: 'Ce lien de réinitialisation a expiré, refaites une demande.' });
    }

    const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        dashboard_password_hash: hasherMotDePasse(nouveauMotDePasse),
        dashboard_reset_token: null,
        dashboard_reset_token_expire: null,
      }),
    });
    if (!patchResp.ok) throw new Error("Échec de l'enregistrement du nouveau mot de passe.");

    const sessionToken = signerToken(draftId, 'artisan', 60 * 60 * 24 * 30);
    return res.status(200).json({ success: true, token: sessionToken });
  } catch (err) {
    console.error('Erreur dashboard-reset-password :', err);
    return res.status(500).json({ success: false, error: 'Impossible de réinitialiser le mot de passe pour le moment.' });
  }
}
