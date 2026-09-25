// /api/estimateur-btp-checkout.js
// Crée une session Stripe pour ACHETER l'Estimateur BTP — 29,90€ HT, achat
// UNIQUE et FIXE, pas d'abonnement ni de forfait (changement du 25/09/2026 :
// avant cette date c'était un essai gratuit de 2 jours puis un abonnement à
// 29,90€ HT/mois ; il n'y a plus ni essai, ni prélèvement récurrent).
//
// Même principe que create-checkout-session.js (Skyeco Pro) pour la TVA :
// elle est directement incluse dans unit_amount (prix TTC), pas de calcul de
// taxe Stripe séparé. mode: 'payment' (paiement unique) — voir
// api/stripe-webhook.js pour la livraison de l'accès une fois ce paiement
// confirmé.
//
// Variable d'environnement requise : STRIPE_SECRET_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const TAUX_TVA = 0.20;
const PRIX_CENTIMES_HT = 2990; // 29,90€ HT, achat unique

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
      mode: 'payment',
      payment_method_types: ['card'],
      locale: 'fr',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: centimesTTC,
            product_data: {
              name: 'Estimateur BTP — accès à vie',
              description: `Achat unique, ${(PRIX_CENTIMES_HT / 100).toFixed(2)} € HT — TVA 20% incluse, aucun abonnement ni prélèvement ultérieur. Calculateur de devis chantier, catalogue de prix BTP, utilisable hors connexion.`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: { product: 'estimateur-btp', email },
      success_url: `${origin}/estimateur-btp.html?paiement=ok&email=${encodeURIComponent(email)}`,
      cancel_url: `${origin}/estimateur-btp.html?paiement=annule`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('estimateur-btp-checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
