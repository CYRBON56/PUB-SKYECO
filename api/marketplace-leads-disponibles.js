// /api/marketplace-leads-disponibles.js
// Catalogue des contacts "marketplace Skyeco" disponibles à l'achat pour
// L'ARTISAN AUTHENTIFIÉ — filtré sur le pilote (métier résine/EPDM,
// département 56/Morbihan, voir claude/skyeco-pro-brief-marketplace-leads.md).
// Ne renvoie JAMAIS nom/téléphone/email tant que le contact n'est pas acheté
// (voir SELECT ci-dessous) — c'est justement ce qui justifie le paiement.
//
// Requête attendue : POST { draftId, token }
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import { verifierToken } from './_lib/marketplace-auth.js';

const METIER_PILOTE = 'resine';
// Pilote limité au Morbihan (56) pour l'instant — Cyrille peut juger lui-même
// la qualité des leads avant d'étendre. Ajouter '22','29','35' ici suffira
// à ouvrir le reste de la Bretagne plus tard, sans autre changement de code.
const DEPARTEMENTS_PILOTE = ['56'];

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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=metier,departement,archive`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }

    const eligible = !draft.archive
      && Array.isArray(draft.metier) && draft.metier.includes(METIER_PILOTE)
      && DEPARTEMENTS_PILOTE.includes(draft.departement);

    if (!eligible) {
      return res.status(200).json({ success: true, eligible: false, leads: [] });
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

    const filtreDepts = DEPARTEMENTS_PILOTE.map(d => `"${d}"`).join(',');
    const leadsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads_marketplace?statut=eq.disponible&metier=eq.${METIER_PILOTE}&departement=in.(${filtreDepts})&select=id,commune,code_postal,type_projet,surface_m2,budget_indicatif,prix_cts,created_at&order=created_at.desc`,
      { headers: supaHeaders }
    );
    if (!leadsResp.ok) throw new Error('Lecture Supabase impossible : ' + (await leadsResp.text()));
    const leads = await leadsResp.json();

    return res.status(200).json({ success: true, eligible: true, leads });
  } catch (err) {
    console.error('Erreur marketplace-leads-disponibles :', err);
    return res.status(500).json({ success: false, error: 'Impossible de charger les contacts pour le moment.' });
  }
}
