// /api/create-checkout-session.js
// Crée une session Stripe pour ABONNER un artisan à Skyeco Pro (récurrent
// mensuel), et non plus un paiement unique de mise en ligne.
// Variables d'environnement requises (à définir dans Vercel, jamais dans le code) :
//   STRIPE_SECRET_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Les 4 forfaits Skyeco Pro — voir forfaits-skyeco-pro.md pour le détail des fonctionnalités.
const FORFAITS = {
  1: { nom: 'Forfait 1 — Vitrine simple', centimes: 3990 },
  2: { nom: 'Forfait 2 — Vitrine + Dashboard', centimes: 5990 },
  3: { nom: 'Forfait 3 — + Relance & devis signés', centimes: 7990 },
  4: { nom: 'Forfait 4 — Vitrine référencée (URL propre)', centimes: 9990 },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draftId, entreprise, plan } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ error: 'draftId manquant' });
  }

  const forfait = FORFAITS[plan] || FORFAITS[1]; // Forfait 1 par défaut si non précisé

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: forfait.centimes,
            recurring: { interval: 'month' },
            product_data: {
              name: forfait.nom + (entreprise ? ' — ' + entreprise : ''),
              description: 'Votre formulaire vitrine en ligne, mis à jour et actif chaque mois.',
            },
          },
          quantity: 1,
        },
      ],
      metadata: { draft_id: draftId, plan: String(plan || 1) },
      subscription_data: {
        metadata: { draft_id: draftId, plan: String(plan || 1) },
      },
      success_url: `${origin}/apercu.html?id=${draftId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/choisir-forfait.html?id=${draftId}&paiement=annule`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session Stripe :', err);
    return res.status(500).json({ error: err.message });
  }
}
