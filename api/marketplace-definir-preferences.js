// /api/marketplace-definir-preferences.js
// Permet à un artisan de personnaliser QUELS métiers/départements il veut
// voir dans le catalogue "Leads Skyeco" (nouveau le 16/09/2026, demandé par
// Cyrille — voir claude/skyeco-pro-brief-marketplace-leads.md). Par défaut
// (préférences vides), le catalogue se base sur le métier/département déjà
// déclarés sur sa vitrine (voir _lib/marketplace-preferences.js) — cet
// endpoint sert seulement à s'en écarter (ex : plusieurs métiers, ou une
// zone plus large que celle de sa vitrine).
//
// Requête attendue : POST { draftId, token, metiers: string[], departements: string[] }
// Un tableau vide (ou omis) réinitialise cette préférence sur "utiliser ma vitrine".
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import { verifierToken } from './_lib/marketplace-auth.js';

const METIERS_CONNUS = ['paysagiste', 'piscine', 'tonte', 'terrasse', 'paysagiste_concepteur', 'arboriste', 'espaces_verts', 'resine', 'autre'];

function departementValide(valeur) {
  return typeof valeur === 'string' && /^[0-9][0-9A-Za-z]{1,2}$/.test(valeur.trim());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token, metiers, departements } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ success: false, error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
  }

  const metiersValides = Array.isArray(metiers) ? metiers.filter(m => METIERS_CONNUS.includes(m)) : [];
  const departementsValides = Array.isArray(departements)
    ? [...new Set(departements.map(d => String(d).trim()).filter(departementValide))]
    : [];

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        // null plutôt que [] quand vide : plus explicite dans la table que
        // "pas de préférence personnalisée", même traitement côté lecture.
        marketplace_metiers_souhaites: metiersValides.length ? metiersValides : null,
        marketplace_departements_souhaites: departementsValides.length ? departementsValides : null,
      }),
    });
    if (!patchResp.ok) {
      const errData = await patchResp.text();
      console.error('Erreur enregistrement préférences marketplace :', errData);
      return res.status(500).json({ success: false, error: 'Impossible d\'enregistrer vos préférences pour le moment.' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur marketplace-definir-preferences :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
