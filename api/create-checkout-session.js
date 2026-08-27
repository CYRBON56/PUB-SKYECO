// /api/create-checkout-session.js
// Crée une session de paiement Stripe pour publier un mini-site Skyeco Pro.
// Variables d'environnement requises (à définir dans Vercel, jamais dans le code) :
//   STRIPE_SECRET_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Tarif de mise en ligne — formule "Pro" (frais de mise en place uniquement pour la V1).
// L'abonnement mensuel récurrent pourra être ajouté dans une V2.
const PRIX_MISE_EN_LIGNE_CENTIMES = 59000; // 590,00 €

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draftId, entreprise } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ error: 'draftId manquant' });
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: PRIX_MISE_EN_LIGNE_CENTIMES,
            product_data: {
              name: 'Mise en ligne du formulaire vitrine Skyeco Pro' + (entreprise ? ' — ' + entreprise : ''),
              description: 'Publication de votre mini-site et activation du suivi des demandes.',
            },
          },
          quantity: 1,
        },
      ],
      metadata: { draft_id: draftId },
      success_url: `${origin}/apercu.html?id=${draftId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/apercu.html?id=${draftId}&paiement=annule`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session Stripe :', err);
    return res.status(500).json({ error: err.message });
  }
}
