// /api/dashboard-set-password.js
// Première création (ou réinitialisation directe par un admin) du mot de
// passe d'accès au tableau de bord (mon-dashboard.html) d'un artisan.
// Utilisé par acces-dashboard.html quand aucun mot de passe n'existe encore
// pour ce site. Renvoie directement un jeton de session pour connecter
// l'artisan sans repasser par l'écran de connexion.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   DASHBOARD_SESSION_SECRET (chaîne aléatoire longue, à définir dans Vercel)

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

  const { draftId, motDePasse } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }
  if (!motDePasse || typeof motDePasse !== 'string' || motDePasse.length < 8) {
    return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=id`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }

    const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        dashboard_password_hash: hasherMotDePasse(motDePasse),
        dashboard_compte_cree_le: new Date().toISOString(),
        dashboard_reset_token: null,
        dashboard_reset_token_expire: null,
      }),
    });
    if (!patchResp.ok) throw new Error("Échec de l'enregistrement du mot de passe.");

    const token = signerToken(draftId, 'artisan', 60 * 60 * 24 * 30); // 30 jours
    return res.status(200).json({ success: true, token });
  } catch (err) {
    console.error('Erreur dashboard-set-password :', err);
    return res.status(500).json({ success: false, error: "Impossible d'enregistrer votre mot de passe pour le moment." });
  }
}
