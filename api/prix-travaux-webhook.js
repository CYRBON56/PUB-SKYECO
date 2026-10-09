// /api/prix-travaux-webhook.js
// Webhook Stripe DÉDIÉ à l'estimateur particuliers (séparé de stripe-webhook.js
// pour ne jamais toucher aux abonnements Skyeco Pro ni aux autres produits).
// Garantit la facture et l'email même si le client ferme la page après avoir payé.
//
// Configuration Stripe : Developers → Webhooks → Add endpoint
//   URL : https://www.skyeco.fr/api/prix-travaux-webhook
//   Événements : checkout.session.completed, checkout.session.async_payment_succeeded
// Variable Vercel : STRIPE_WEBHOOK_SECRET_PRIX_TRAVAUX (le « Signing secret » de ce endpoint)

import Stripe from 'stripe';
import { finaliserCommande } from './_lib/prix-travaux-commande.js';
import { finaliserPrecommande } from './_lib/precommande.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false } };

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(await buffer(req), req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET_PRIX_TRAVAUX);
  } catch (e) {
    return res.status(400).send(`Signature invalide : ${e.message}`);
  }
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const session = event.data.object;
    if (session.metadata?.product === 'prix-travaux') {
      try { await finaliserCommande(session); }
      catch (e) { console.error('prix-travaux-webhook :', e.message); return res.status(500).send('Erreur, Stripe réessaiera'); }
    }
    // 09/10/2026 : précommandes des applis d'hiver (même endpoint Stripe)
    if (session.metadata?.product === 'precommande') {
      try { await finaliserPrecommande(session); }
      catch (e) { console.error('prix-travaux-webhook (précommande) :', e.message); return res.status(500).send('Erreur, Stripe réessaiera'); }
    }
  }
  return res.status(200).json({ received: true });
}
