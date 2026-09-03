// /api/create-ad-budget-checkout.js
// Crée une session de paiement Stripe UNIQUE (pas un abonnement) pour le
// budget publicitaire que l'artisan choisit d'investir ce mois-ci.
// Distinct de l'abonnement mensuel (39,90€) — c'est un paiement séparé,
// à refaire à chaque fois que l'artisan veut (re)financer sa campagne.
//
// Garde-fou ajouté le 03/09 : ce paiement (une fois confirmé par
// confirm-ad-payment.js) déclenche automatiquement la création d'une VRAIE
// campagne sur le VRAI compte Google Ads (voir create-google-ads-campaign.js)
// — sans jamais vérifier ni le statut de la fiche ni le fait que le forfait
// ait été réellement payé ou simulé via simuler-paiement-test.js. On bloque
// donc ici, au tout premier point d'entrée du financement du budget pub, tant
// que Cyrille n'a pas validé le site lui-même (site_valide) — même contrôle
// que celui déjà en place dans create-checkout-session.js /
// demarrer-essai-gratuit.js pour le paiement du forfait.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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
    const verifResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=site_valide`,
      { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const verifRows = await verifResp.json();
    if (!verifRows[0]?.site_valide) {
      return res.status(403).json({ error: "Ce site n'a pas encore été validé — demandez la validation depuis votre page." });
    }

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
