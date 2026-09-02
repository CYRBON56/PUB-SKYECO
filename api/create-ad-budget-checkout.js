// /api/create-ad-budget-checkout.js
// Crée une session de paiement Stripe UNIQUE (pas un abonnement) pour le
// budget publicitaire que l'artisan choisit d'investir ce mois-ci.
// Distinct de l'abonnement mensuel (39,90€) — c'est un paiement séparé,
// à refaire à chaque fois que l'artisan veut (re)financer sa campagne.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const BUDGET_MIN = 100;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draftId, budget } = req.body || {};
  const budgetNum = parseFloat(budget);

  if (!draftId) {
    return res.status(400).json({ error: 'draftId manquant' });
  }
  if (!budgetNum || budgetNum < BUDGET_MIN) {
    return res.status(400).json({ error: `Le montant minimum est de ${BUDGET_MIN} €.` });
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      locale: 'fr',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: Math.round(budgetNum * 100),
            product_data: {
              name: 'Budget publicitaire Skyeco Ads',
              description: `Financement de campagne — ${budgetNum} € (dont commission de service incluse).`,
              images: ['https://www.skyeco.fr/skyeco-google-ads-carre.png'],
            },
          },
          quantity: 1,
        },
      ],
      metadata: { draft_id: draftId, budget: String(budgetNum), type: 'ad_budget' },
      success_url: `${origin}/campagne.html?id=${draftId}&session_id={CHECKOUT_SESSION_ID}&lance=1`,
      cancel_url: `${origin}/campagne.html?id=${draftId}&paiement=annule`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session budget pub :', err);
    return res.status(500).json({ error: err.message });
  }
}
