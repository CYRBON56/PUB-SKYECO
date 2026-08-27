// /api/confirm-payment.js
// Vérifie côté serveur qu'une session Stripe a bien été payée, puis passe
// le brouillon correspondant en statut "published" dans Supabase.
// Variables d'environnement requises (à définir dans Vercel, jamais dans le code) :
//   STRIPE_SECRET_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//
// Important : on utilise ici la clé service_role (jamais exposée au navigateur)
// pour pouvoir modifier le statut, alors que le front-end n'a que la clé anon
// en lecture/insertion. C'est ce qui empêche quelqu'un de "publier" un site
// sans payer en appelant directement l'API Supabase depuis le navigateur.

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
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Paiement non confirmé.' });
    }
    if (session.metadata?.draft_id !== draftId) {
      return res.status(400).json({ error: "Cette session ne correspond pas à cet aperçu." });
    }

    const { error } = await supabaseAdmin
      .from('skyeco_pro_vitrine_drafts')
      .update({ status: 'published', updated_at: new Date().toISOString() })
      .eq('id', draftId);

    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur confirmation paiement :', err);
    return res.status(500).json({ error: err.message });
  }
}
