// /api/estimateur-btp-checkout.js
// Crée une session Stripe pour ABONNER un email à l'Estimateur BTP après la
// fin de son essai gratuit de 5 jours (ou avant, s'il choisit de payer plus
// tôt) — 29,90€ HT/mois, sans engagement.
//
// Même principe que create-checkout-session.js (Skyeco Pro) : la TVA (20%)
// est directement incluse dans unit_amount (prix TTC), pas de calcul de taxe
// Stripe séparé. Contrairement à Skyeco Pro, PAS de trial_period_days ici :
// l'essai gratuit de 5 jours est déjà géré en dehors de Stripe (sans carte
// bancaire, voir estimateur-btp-essai.js) — arriver jusqu'à ce paiement
// signifie que l'essai est fini (ou que la personne choisit de payer
// directement), donc le prélèvement démarre immédiatement.
//
// Variable d'environnement requise : STRIPE_SECRET_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const TAUX_TVA = 0.20;
const PRIX_CENTIMES_HT = 2990; // 29,90€ HT/mois

function emailValide(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!emailValide(email)) {
    return res.status(400).json({ error: 'Email invalide' });
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;
  const centimesTTC = Math.round(PRIX_CENTIMES_HT * (1 + TAUX_TVA));

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      locale: 'fr',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: centimesTTC,
            recurring: { interval: 'month' },
            product_data: {
              name: 'Estimateur BTP — accès illimité',
              description: `Sans engagement, vous arrêtez quand vous voulez. ${(PRIX_CENTIMES_HT / 100).toFixed(2)} € HT/mois — TVA 20% incluse. Calculateur de devis chantier, catalogue de prix BTP, utilisable hors connexion.`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: { product: 'estimateur-btp', email },
      subscription_data: {
        metadata: { product: 'estimateur-btp', email },
      },
      success_url: `${origin}/estimateur-btp.html?paiement=ok&email=${encodeURIComponent(email)}`,
      cancel_url: `${origin}/estimateur-btp.html?paiement=annule`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('estimateur-btp-checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
