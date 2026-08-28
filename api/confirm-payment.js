// /api/confirm-payment.js
// Vérifie côté serveur qu'une session Stripe d'ABONNEMENT a bien été activée,
// puis passe le brouillon correspondant en statut "published" dans Supabase,
// avec le suivi de l'abonnement (id, statut) pour la suite (renouvellement,
// annulation — voir le webhook Stripe à ajouter en V2 pour ça).
//
// Variables d'environnement requises (à définir dans Vercel, jamais dans le code) :
//   STRIPE_SECRET_KEY
//   SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  'https://wklddwumirkdjkbxvzyj.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { sessionId, draftId } = req.body || {};
  if (!sessionId || !draftId) {
    return res.status(400).json({ error: 'sessionId ou draftId manquant' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Paiement non confirmé.' });
    }
    if (session.metadata?.draft_id !== draftId) {
      return res.status(400).json({ error: "Cette session ne correspond pas à cet aperçu." });
    }
    if (session.mode !== 'subscription' || !session.subscription) {
      return res.status(400).json({ error: "Cette session n'est pas un abonnement valide." });
    }

    const subscription = session.subscription;

    const { error } = await supabaseAdmin
      .from('skyeco_pro_vitrine_drafts')
      .update({
        status: 'published',
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status, // 'active', 'trialing', etc.
        forfait: parseInt(session.metadata?.plan || '1', 10),
        updated_at: new Date().toISOString(),
      })
      .eq('id', draftId);

    if (error) throw error;

    return res.status(200).json({ success: true, subscriptionStatus: subscription.status });
  } catch (err) {
    console.error('Erreur confirmation paiement :', err);
    return res.status(500).json({ error: err.message });
  }
}
