// /api/marketplace-reserver-lead.js
// Étape 1 de l'achat d'un contact marketplace : verrouille le lead pour CET
// artisan (empêche qu'un autre l'achète pendant le paiement Stripe), puis
// crée une session Stripe Checkout à l'unité (mode "payment", PAS un
// abonnement — voir api/create-ad-budget-checkout.js pour le même schéma).
//
// Verrou anti-double-vente : la mise à jour ci-dessous est un seul UPDATE
// SQL avec une clause WHERE (statut = 'disponible' OU réservation expirée) —
// PostgREST/Postgres l'exécute atomiquement, donc si deux artisans cliquent
// en même temps, un seul des deux UPDATE affectera une ligne ; l'autre
// recevra un tableau vide et donc l'erreur "déjà réservé" ci-dessous.
//
// Requête attendue : POST { draftId, token, leadId }
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import Stripe from 'stripe';
import { verifierToken } from './_lib/marketplace-auth.js';
import { preferencesEffectives } from './_lib/marketplace-preferences.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const RESERVATION_MINUTES = 15;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token, leadId } = req.body || {};
  if (!draftId || !token || !leadId) {
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
    // Re-vérifie l'éligibilité côté serveur (défense en profondeur — un
    // artisan hors de ses propres préférences ne doit pas pouvoir acheter en
    // appelant l'API directement, même si l'UI ne lui montre pas ce contact).
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=metier,departement,archive,entreprise,email,marketplace_metiers_souhaites,marketplace_departements_souhaites`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];
    if (!draft || draft.archive) {
      return res.status(403).json({ success: false, error: "Ce catalogue n'est pas encore disponible pour votre profil." });
    }
    const prefs = preferencesEffectives(draft);
    if (!prefs.metiers.length || !prefs.departements.length) {
      return res.status(403).json({ success: false, error: "Ce catalogue n'est pas encore disponible pour votre profil." });
    }

    const nowIso = new Date().toISOString();
    const reserveExpireAt = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000).toISOString();

    // Le filtre metier/departement dans l'URL fait à la fois office de
    // contrôle d'accès (n'affecte aucune ligne si ce lead n'est pas dans le
    // périmètre de cet artisan) ET de verrou anti-double-vente — un seul
    // UPDATE conditionnel, atomique.
    const filtreMetiers = prefs.metiers.map(m => `"${m}"`).join(',');
    const filtreDepts = prefs.departements.map(d => `"${d}"`).join(',');
    const reserveResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads_marketplace?id=eq.${leadId}&metier=in.(${filtreMetiers})&departement=in.(${filtreDepts})&or=(statut.eq.disponible,and(statut.eq.reserve,reserve_expire_at.lt.${encodeURIComponent(nowIso)}))`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          statut: 'reserve',
          reserve_par_draft_id: draftId,
          reserve_expire_at: reserveExpireAt,
          stripe_checkout_session_id: null,
        }),
      }
    );
    if (!reserveResp.ok) throw new Error('Réservation impossible : ' + (await reserveResp.text()));
    const reserved = await reserveResp.json();
    if (!Array.isArray(reserved) || reserved.length === 0) {
      return res.status(409).json({ success: false, error: "Ce contact n'est plus disponible (déjà réservé par un autre artisan, ou hors de votre périmètre actuel) — actualisez la liste." });
    }
    const lead = reserved[0];

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      locale: 'fr',
      invoice_creation: { enabled: true },
      customer_email: draft.email || undefined,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: lead.prix_cts,
            product_data: {
              name: `Contact Skyeco — ${lead.type_projet || lead.metier || 'projet'}`,
              description: `${lead.commune || lead.code_postal || ''} — contact exclusif, coordonnées débloquées après paiement.`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: { lead_id: leadId, draft_id: draftId, type: 'marketplace_lead' },
      success_url: `${origin}/mon-dashboard.html?id=${draftId}&marketplace_session_id={CHECKOUT_SESSION_ID}#marketplace`,
      cancel_url: `${origin}/mon-dashboard.html?id=${draftId}&marketplace_annule=1#marketplace`,
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads_marketplace?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ stripe_checkout_session_id: session.id }),
    });

    return res.status(200).json({ success: true, url: session.url });
  } catch (err) {
    console.error('Erreur marketplace-reserver-lead :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
