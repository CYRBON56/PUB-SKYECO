// /api/dashboard-login.js
// Connecte un artisan à son tableau de bord (mon-dashboard.html) avec son
// email (identifiant) et son mot de passe. Renvoie un jeton de session signé
// que le navigateur conserve (sessionStorage) et présente à
// dashboard-verify-session.js à chaque chargement du dashboard.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

function verifierMotDePasse(motDePasse, stocke) {
  if (!stocke || !stocke.includes(':')) return false;
  const [sel, hash] = stocke.split(':');
  try {
    const essai = crypto.scryptSync(motDePasse, sel, 64);
    const attendu = Buffer.from(hash, 'hex');
    if (essai.length !== attendu.length) return false;
    return crypto.timingSafeEqual(essai, attendu);
  } catch (e) {
    return false;
  }
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

  const { email, motDePasse } = req.body || {};
  if (!email || !motDePasse) {
    return res.status(400).json({ success: false, error: 'Email et mot de passe requis.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    // Un même email peut correspondre à plusieurs brouillons de test — on ne
    // veut que celui qui a réellement un compte dashboard créé (le plus
    // récent s'il y en a plusieurs), jamais un brouillon sans mot de passe
    // pris au hasard par une requête non triée.
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?email=ilike.${encodeURIComponent(email.trim())}&dashboard_password_hash=not.is.null&order=dashboard_compte_cree_le.desc&limit=1&select=id,dashboard_password_hash`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();
    const draft = rows[0];

    // Message volontairement générique (identifiant OU mot de passe) pour ne
    // pas laisser deviner si un email existe en base.
    if (!draft || !draft.dashboard_password_hash || !verifierMotDePasse(motDePasse, draft.dashboard_password_hash)) {
      return res.status(401).json({ success: false, error: 'Identifiant ou mot de passe incorrect.' });
    }

    const token = signerToken(draft.id, 'artisan', 60 * 60 * 24 * 30); // 30 jours
    return res.status(200).json({ success: true, draftId: draft.id, token });
  } catch (err) {
    console.error('Erreur dashboard-login :', err);
    return res.status(500).json({ success: false, error: 'Connexion impossible pour le moment.' });
  }
}
