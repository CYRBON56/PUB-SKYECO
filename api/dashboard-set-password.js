// /api/dashboard-set-password.js
// Première création (ou réinitialisation directe par un admin) du mot de
// passe d'accès au tableau de bord d'un artisan. Utilisé par
// acces-dashboard.html quand aucun mot de passe n'existe encore pour ce
// site.
//
// Le mot de passe est celui du COMPTE (identifié par l'email), pas d'un
// site précis : s'il existe déjà d'autres vitrines sous le même email,
// elles reçoivent automatiquement le même mot de passe — un seul
// identifiant/mot de passe donne accès à toutes les vitrines d'un même
// artisan. Renvoie un jeton de session lié au compte (valable pour tous ses
// sites) pour connecter l'artisan sans repasser par l'écran de connexion.
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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=id,email`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    const draft = rows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }

    const hash = hasherMotDePasse(motDePasse);
    const maintenant = new Date().toISOString();

    const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        dashboard_password_hash: hash,
        dashboard_compte_cree_le: maintenant,
        dashboard_reset_token: null,
        dashboard_reset_token_expire: null,
      }),
    });
    if (!patchResp.ok) throw new Error("Échec de l'enregistrement du mot de passe.");

    // Propage le même mot de passe aux autres vitrines du même artisan
    // (même email) : un seul identifiant/mot de passe pour tout le compte.
    // Best-effort — une erreur ici ne doit pas bloquer la création du tout
    // premier accès.
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

    const token = signerTokenCompte(draft.email, 60 * 60 * 24 * 30); // 30 jours
    return res.status(200).json({ success: true, token });
  } catch (err) {
    console.error('Erreur dashboard-set-password :', err);
    return res.status(500).json({ success: false, error: "Impossible d'enregistrer votre mot de passe pour le moment." });
  }
}
