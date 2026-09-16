// /api/marketplace-leads-disponibles.js
// Catalogue des contacts "marketplace Skyeco" disponibles à l'achat pour
// L'ARTISAN AUTHENTIFIÉ — filtré par défaut sur SON PROPRE métier/département
// (déclarés sur sa vitrine), ou sur les préférences personnalisées qu'il a
// enregistrées via api/marketplace-definir-preferences.js (voir
// _lib/marketplace-preferences.js pour la règle exacte, généralisée le
// 16/09/2026 — ce n'était au départ qu'un pilote figé sur "résine"/"56").
// Ne renvoie JAMAIS nom/téléphone/email tant que le contact n'est pas acheté
// (voir SELECT ci-dessous) — c'est justement ce qui justifie le paiement.
//
// Requête attendue : POST { draftId, token }
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import { verifierToken } from './_lib/marketplace-auth.js';
import { preferencesEffectives } from './_lib/marketplace-preferences.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ success: false, error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=metier,departement,archive,marketplace_metiers_souhaites,marketplace_departements_souhaites`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }

    const prefs = preferencesEffectives(draft);
    const eligible = !draft.archive && prefs.metiers.length > 0 && prefs.departements.length > 0;

    if (!eligible) {
      return res.status(200).json({
        success: true,
        eligible: false,
        leads: [],
        preferences: { metiers: prefs.metiers, departements: prefs.departements, personnalisees: prefs.utiliseValeursPersonnalisees },
        metierVitrine: Array.isArray(draft.metier) ? draft.metier : [],
        departementVitrine: draft.departement || null,
      });
    }

    // Auto-guérison des réservations expirées (paiement Stripe abandonné) —
    // remet le contact disponible sans tâche planifiée (cron) nécessaire.
    const nowIso = new Date().toISOString();
    await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads_marketplace?statut=eq.reserve&reserve_expire_at=lt.${encodeURIComponent(nowIso)}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ statut: 'disponible', reserve_par_draft_id: null, reserve_expire_at: null, stripe_checkout_session_id: null }),
      }
    );

    const filtreMetiers = prefs.metiers.map(m => `"${m}"`).join(',');
    const filtreDepts = prefs.departements.map(d => `"${d}"`).join(',');
    const leadsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads_marketplace?statut=eq.disponible&metier=in.(${filtreMetiers})&departement=in.(${filtreDepts})&select=id,metier,commune,code_postal,type_projet,surface_m2,budget_indicatif,prix_cts,created_at&order=created_at.desc`,
      { headers: supaHeaders }
    );
    if (!leadsResp.ok) throw new Error('Lecture Supabase impossible : ' + (await leadsResp.text()));
    const leads = await leadsResp.json();

    return res.status(200).json({
      success: true,
      eligible: true,
      leads,
      preferences: { metiers: prefs.metiers, departements: prefs.departements, personnalisees: prefs.utiliseValeursPersonnalisees },
      metierVitrine: Array.isArray(draft.metier) ? draft.metier : [],
      departementVitrine: draft.departement || null,
    });
  } catch (err) {
    console.error('Erreur marketplace-leads-disponibles :', err);
    return res.status(500).json({ success: false, error: 'Impossible de charger les contacts pour le moment.' });
  }
}
