// /api/precommande-checkout.js
// 09/10/2026 — Crée la précommande (en_attente) et la session Stripe pour
// meteo-chantier.html, stock-granules.html et facture-chauffage.html.

import Stripe from 'stripe';
import { sb, PRODUITS, DATE_LIMITE } from './_lib/precommande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('preco:' + ipDepuisRequete(req), 10, 600))) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  const produit = req.body?.produit;
  if (typeof produit !== 'string' || !Object.hasOwn(PRODUITS, produit)) return res.status(400).json({ error: 'Produit inconnu' });
  const p = PRODUITS[produit];
  const metier = typeof req.body?.metier === 'string' ? req.body.metier.slice(0, 40).replace(/[^\p{L} '-]/gu, '') : null;
  const source = typeof req.body?.source === 'string' ? req.body.source.slice(0, 40).replace(/[^a-z0-9_-]/gi, '') : null;
  const origin = req.headers.origin || `https://${req.headers.host}`;
  try {
    const [c] = await sb('precommandes', { method: 'POST', body: JSON.stringify({ produit, montant_ttc: p.prix, metier: metier || null, source: source || null }) });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      locale: 'fr',
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(p.prix * 100),
          product_data: { name: `${p.nom} (précommande)`, description: `Appli livrée à sa sortie, au plus tard le ${DATE_LIMITE}, sinon remboursement intégral automatique. TVA 20 % incluse.` },
        },
        quantity: 1,
      }],
      custom_text: { submit: { message: `Précommande : vous recevrez l'appli par email à sa sortie, au plus tard le ${DATE_LIMITE}. Sinon, remboursement intégral et automatique. Annulation possible à tout moment avant la sortie.` } },
      metadata: { product: 'precommande', precommande_id: c.id, produit },
      payment_intent_data: { metadata: { product: 'precommande', precommande_id: c.id, produit } },
      success_url: `${origin}/${p.page}?precommande=ok&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/${p.page}?precommande=annule`,
    });
    await sb(`precommandes?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ stripe_session_id: session.id }) });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('precommande-checkout :', e.message);
    return res.status(500).json({ error: "Le paiement n'a pas pu être préparé. Réessayez dans un instant." });
  }
}
