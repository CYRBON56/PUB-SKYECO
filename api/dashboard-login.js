// /api/dashboard-login.js
// Connecte un artisan à son COMPTE Skyeco Pro avec son email (identifiant)
// et son mot de passe. Un même compte (email) peut regrouper PLUSIEURS
// vitrines/sites — par exemple un artisan avec plusieurs activités
// différentes. Le jeton renvoyé est donc lié au COMPTE (email), pas à un
// site précis : il donne accès à TOUTES les vitrines de cet artisan. La
// liste de ces vitrines est renvoyée pour alimenter un sélecteur de site
// dans le tableau de bord.
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

function signerTokenCompte(email, dureeSecondes) {
  const exp = Math.floor(Date.now() / 1000) + dureeSecondes;
  const emailB64 = Buffer.from(email.trim().toLowerCase()).toString('base64url');
  const payload = `${emailB64}.artisan.${exp}`;
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
    // Un même email peut correspondre à plusieurs vitrines (compte avec
    // plusieurs sites, ou anciens brouillons de test) — on récupère tout ce
    // qui a un mot de passe et on vérifie sur l'ensemble, au lieu de ne
    // regarder que la ligne la plus récente comme avant (ce qui rendait les
    // vitrines plus anciennes du même artisan inaccessibles).
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?email=ilike.${encodeURIComponent(email.trim())}&dashboard_password_hash=not.is.null&order=dashboard_compte_cree_le.asc&select=id,entreprise,zone,metier,status,dashboard_password_hash`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();

    // Message volontairement générique (identifiant OU mot de passe) pour ne
    // pas laisser deviner si un email existe en base.
    const motDePasseValide = rows.some((r) => verifierMotDePasse(motDePasse, r.dashboard_password_hash));
    if (rows.length === 0 || !motDePasseValide) {
      return res.status(401).json({ success: false, error: 'Identifiant ou mot de passe incorrect.' });
    }

    const token = signerTokenCompte(email, 60 * 60 * 24 * 30); // 30 jours
    const sites = rows.map((r) => ({ id: r.id, entreprise: r.entreprise, zone: r.zone, metier: r.metier, status: r.status }));

    return res.status(200).json({ success: true, draftId: sites[0].id, token, sites });
  } catch (err) {
    console.error('Erreur dashboard-login :', err);
    return res.status(500).json({ success: false, error: 'Connexion impossible pour le moment.' });
  }
}
