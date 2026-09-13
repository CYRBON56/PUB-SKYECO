// /api/create-ad-budget-checkout.js
// Crée une session de paiement Stripe UNIQUE (pas un abonnement) pour le
// budget publicitaire que l'artisan choisit d'investir ce mois-ci.
// Distinct de l'abonnement mensuel (39,90€) — c'est un paiement séparé,
// à refaire à chaque fois que l'artisan veut (re)financer sa campagne.
//
// 12/09/2026 : le blocage strict sur site_valide (qui empêchait tout
// paiement tant que Cyrille n'avait pas validé le site à la main) a été
// retiré — décision de Cyrille pour permettre le nouveau parcours d'essai
// par téléphone seul, où le site n'est jamais validé manuellement avant ce
// paiement. Le site reste malgré tout vérifié avant sa mise en ligne
// effective : voir le message renvoyé par confirm-ad-payment.js après
// paiement ("votre campagne a été créée en pause — elle sera vérifiée
// avant diffusion"), qui reste la garantie de contrôle qualité, sans
// bloquer l'inscription/le paiement lui-même.
//
// Transparence (10/09/2026, demandé par Cyrille) : le libellé Stripe
// détaille désormais le montant HT réellement dépensé en diffusion Google
// Ads et la commission de service (30% du HT, voir TAUX_COMMISSION dans
// create-google-ads-campaign.js / estimate-reach.js / etc. — même taux
// partout), au lieu de la seule mention vague "commission incluse". Le
// montant total facturé (budgetNum) et son traitement dans
// confirm-ad-payment.js / create-google-ads-campaign.js ne changent pas.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const BUDGET_MIN = 100;
const TAUX_TVA = 0.20;
const TAUX_COMMISSION = 0.30;

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
    const budgetHT = Math.round((budgetNum / (1 + TAUX_TVA)) * 100) / 100;
    const commission = Math.round(budgetHT * TAUX_COMMISSION * 100) / 100;
    const budgetNetPub = Math.round((budgetHT - commission) * 100) / 100;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      locale: 'fr',
      invoice_creation: { enabled: true },
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: Math.round(budgetNum * 100),
            product_data: {
              name: 'Budget publicitaire Skyeco IA Ads',
              description: `${budgetNum} € TTC — dont ${budgetNetPub} € HT réellement dépensés en diffusion sur Google Ads et ${commission} € HT de commission de service Skyeco IA Ads (30%). Votre site sera vérifié par notre équipe avant sa mise en ligne.`,
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
