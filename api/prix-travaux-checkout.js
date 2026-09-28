// /api/prix-travaux-checkout.js
// Crée la commande (statut en_attente) puis la session de paiement Stripe
// pour l'estimation détaillée de skyeco.fr/prix-travaux.html (35,90 € TTC).
// Variables requises : STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe';
import { sb, METIERS, PRIX_TTC, nettoyerReponses } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('pt-checkout:' + ipDepuisRequete(req), 10, 600))) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  const metier = req.body?.metier;
  if (typeof metier !== 'string' || !Object.hasOwn(METIERS, metier)) return res.status(400).json({ error: 'Type de travaux inconnu' });
  const reponses = nettoyerReponses(req.body?.reponses);
  if (!reponses || typeof reponses.projet !== 'string') return res.status(400).json({ error: 'Réponses invalides' });
  const dept = String(reponses.dept || '').toUpperCase();
  const qty = Number(reponses.qty);
  if (!/^(\d{2}|2A|2B|97\d)$/.test(dept) || !(qty > 0 && qty < 100000)) return res.status(400).json({ error: 'Département ou quantité invalide' });

  const origin = req.headers.origin || `https://${req.headers.host}`;
  try {
    const [c] = await sb('prix_travaux_commandes', {
      method: 'POST',
      body: JSON.stringify({ metier, departement: dept, quantite: qty, reponses, montant_ttc: PRIX_TTC }),
    });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      locale: 'fr',
      billing_address_collection: 'required',
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(PRIX_TTC * 100),
          product_data: {
            name: `Estimation détaillée de travaux : ${METIERS[metier]}`,
            description: `Département ${dept}. Détail poste par poste, comparaison de devis illimitée pour ce projet. TVA 20 % incluse.`,
          },
        },
        quantity: 1,
      }],
      custom_text: {
        submit: { message: "En payant, vous acceptez nos CGV (skyeco.fr/cgv-estimateur.html), vous demandez l'accès immédiat à votre estimation et vous renoncez à votre droit de rétractation dès le début de son utilisation. Votre facture vous est envoyée par email." },
      },
      metadata: { product: 'prix-travaux', commande_id: c.id, metier, departement: dept },
      payment_intent_data: { metadata: { product: 'prix-travaux', commande_id: c.id } },
      success_url: `${origin}/prix-travaux.html?paiement=ok&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/prix-travaux.html?paiement=annule&metier=${metier}`,
    });
    await sb(`prix_travaux_commandes?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ stripe_session_id: session.id }) });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('prix-travaux-checkout :', e.message);
    return res.status(500).json({ error: 'Le paiement n\'a pas pu être préparé. Réessayez dans un instant.' });
  }
}
