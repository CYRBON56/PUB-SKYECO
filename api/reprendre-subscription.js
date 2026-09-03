// /api/reprendre-subscription.js
// Reprend manuellement un abonnement mis en pause, sans attendre les 30
// jours de reprise automatique — et repasse le site en ligne.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=stripe_subscription_id`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    const draft = rows[0];

    if (!draft?.stripe_subscription_id) {
      // Compte en essai gratuit (pas d'abonnement Stripe réel) — on reprend
      // directement en base, sans passer par Stripe. Ajouté le 03/09 :
      // auparavant, un essai gratuit qui se mettait en pause ne pouvait
      // ensuite plus jamais être repris ("Aucun abonnement trouvé").
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ subscription_status: 'active', status: 'essai' }),
      });
      return res.status(200).json({ success: true, message: 'Diffusion reprise.' });
    }

    await stripe.subscriptions.update(draft.stripe_subscription_id, {
      pause_collection: '', // retire la pause côté Stripe
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'published', subscription_status: 'active' }),
    });

    return res.status(200).json({ success: true, message: 'Abonnement repris. Votre site est de nouveau en ligne.' });
  } catch (err) {
    console.error('Erreur reprendre-subscription :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
