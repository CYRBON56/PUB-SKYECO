// /api/confirm-ad-payment.js
// Vérifie que le paiement du budget publicitaire a bien été effectué, met à
// jour le budget du site, PUIS déclenche create-google-ads-campaign.js — qui
// crée la campagne la toute première fois (paused, en attente de validation
// par Cyrille), ou simplement met à jour son budget et la relance si elle
// avait été mise en pause automatiquement pour solde épuisé lors d'une
// recharge suivante (03/09 — voir le commentaire d'en-tête de ce fichier).
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { sessionId, draftId } = req.body || {};
  if (!sessionId || !draftId) {
    return res.status(400).json({ error: 'sessionId ou draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Paiement non confirmé.' });
    }
    if (session.metadata?.draft_id !== draftId || session.metadata?.type !== 'ad_budget') {
      return res.status(400).json({ error: "Cette session ne correspond pas à cette campagne." });
    }

    const budget = parseFloat(session.metadata.budget);

    // 1. Met à jour le budget publicitaire du site.
    const updateResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          tarif_actif: true,
          tarif_prix: budget,
          derniere_recharge_le: new Date().toISOString(),
          alerte_solde_bas_envoyee: false, // nouveau cycle de budget, l'alerte pourra repartir
        }),
      }
    );
    if (!updateResp.ok) {
      const errData = await updateResp.json().catch(() => ({}));
      console.error('Erreur mise à jour budget :', JSON.stringify(errData));
      return res.status(500).json({ error: 'Budget payé mais non enregistré — contactez le support.' });
    }

    // 2. Déclenche la création de la campagne Google Ads (appel interne serveur-à-serveur).
    const origin = req.headers.origin || `https://${req.headers.host}`;
    let campagne = null;
    try {
      const campagneResp = await fetch(`${origin}/api/create-google-ads-campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_id: draftId }),
      });
      const campagneData = await campagneResp.json();
      if (campagneResp.ok) {
        campagne = campagneData;
      } else {
        console.error('Campagne Google Ads non créée automatiquement :', JSON.stringify(campagneData));
      }
    } catch (campagneErr) {
      console.error('Erreur appel création campagne :', campagneErr);
    }

    return res.status(200).json({
      success: true,
      budgetActif: budget,
      campagneCreee: !!campagne?.success,
      campagneMessage: campagne?.success
        ? "Votre campagne a été créée en pause — elle sera vérifiée avant diffusion."
        : "Budget enregistré, mais la campagne n'a pas pu être créée automatiquement. Notre équipe s'en occupe.",
    });
  } catch (err) {
    console.error('Erreur confirm-ad-payment :', err);
    return res.status(500).json({ error: err.message });
  }
}
