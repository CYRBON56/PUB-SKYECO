// /api/dashboard-reset-password.js
// Étape finale du "mot de passe oublié" : vérifie le jeton reçu par
// SMS/email (dashboard-forgot-password.js) puis enregistre le nouveau mot
// de passe pour TOUT le compte (toutes les vitrines rattachées au même
// email), pas seulement celle utilisée pour la demande — un artisan avec
// plusieurs sites garde un seul identifiant/mot de passe. Reconnecte
// directement l'artisan (jeton de session lié au compte, valable pour tous
// ses sites).
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

function signerTokenCompte(email, dureeSecondes) {
  const exp = Math.floor(Date.now() / 1000) + dureeSecondes;
  const emailB64 = Buffer.from(String(email || '').trim().toLowerCase()).toString('base64url');
  const payload = `${emailB64}.artisan.${exp}`;
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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=email,dashboard_reset_token,dashboard_reset_token_expire`,
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

    const hash = hasherMotDePasse(nouveauMotDePasse);

    const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        dashboard_password_hash: hash,
        dashboard_reset_token: null,
        dashboard_reset_token_expire: null,
      }),
    });
    if (!patchResp.ok) throw new Error("Échec de l'enregistrement du nouveau mot de passe.");

    // Même mot de passe propagé aux autres vitrines du même compte (email).
    if (draft.email) {
      try {
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?email=ilike.${encodeURIComponent(draft.email)}&id=neq.${draftId}`,
          {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ dashboard_password_hash: hash }),
          }
        );
      } catch (e) {
        console.error('Propagation mot de passe aux autres sites échouée (non bloquant) :', e);
      }
    }

    const sessionToken = signerTokenCompte(draft.email, 60 * 60 * 24 * 30);
    return res.status(200).json({ success: true, token: sessionToken });
  } catch (err) {
    console.error('Erreur dashboard-reset-password :', err);
    return res.status(500).json({ success: false, error: 'Impossible de réinitialiser le mot de passe pour le moment.' });
  }
}
