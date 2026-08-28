// /api/pause-subscription.js
// Met l'abonnement Stripe en pause pour 1 mois — aucun prélèvement pendant
// cette période, puis reprise AUTOMATIQUE (Stripe gère ça nativement via
// pause_collection.resumes_at, pas besoin de cron pour relancer).
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

  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ error: 'draftId manquant' });
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
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];

    if (!draft?.stripe_subscription_id) {
      return res.status(404).json({ error: 'Aucun abonnement actif trouvé pour ce site.' });
    }

    const dansUnMois = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await stripe.subscriptions.update(draft.stripe_subscription_id, {
      pause_collection: {
        behavior: 'void', // aucune facture générée pendant la pause
        resumes_at: dansUnMois,
      },
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ subscription_status: 'en_pause' }),
    });

    return res.status(200).json({
      success: true,
      message: `Abonnement mis en pause. Aucun prélèvement pendant 1 mois — reprise automatique le ${new Date(dansUnMois * 1000).toLocaleDateString('fr-FR')}.`,
      reprisele: dansUnMois,
    });
  } catch (err) {
    console.error('Erreur pause-subscription :', err);
    return res.status(500).json({ error: err.message });
  }
}
