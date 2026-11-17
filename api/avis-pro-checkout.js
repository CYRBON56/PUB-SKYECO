// /api/avis-pro-checkout.js
// Crée la session Stripe d'abonnement mensuel Avis Pro pour une inscription
// déjà enregistrée (avis_pro_inscriptions). Prix HT ci-dessous, TVA 20 %
// intégrée au montant facturé, comme pour Skyeco Pro (create-checkout-session.js).
// Le webhook Stripe (stripe-webhook.js) passe ensuite l'inscription en « abonne ».
import Stripe from 'stripe';
import { sb } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const TAUX_TVA = 0.20;
const FORFAITS = {
  starter: { nom: 'Avis Pro Starter — réponses à vos avis Google + bilan mensuel', centimesHT: 2900 },
  pro: { nom: 'Avis Pro Pro — réponses aux avis, SMS de demande d\'avis, veille concurrents', centimesHT: 4900 },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('avispro-pay:' + ipDepuisRequete(req), 10, 600))) return res.status(429).json({ error: 'Trop de tentatives, patientez quelques minutes.' });
  const id = parseInt(req.body?.id, 10);
  const jeton = String(req.body?.jeton || '');
  if (!id || !jeton) return res.status(400).json({ error: 'Inscription introuvable.' });
  try {
    const rows = await sb(`avis_pro_inscriptions?id=eq.${id}&select=id,siret,entreprise,email,forfait,created_at`);
    const ins = rows && rows[0];
    // Jeton = SIRET + date de création : empêche de payer pour l'inscription de quelqu'un d'autre en devinant un id.
    if (!ins || jeton !== `${ins.siret}-${new Date(ins.created_at).getTime()}`) return res.status(404).json({ error: 'Inscription introuvable.' });
    const f = FORFAITS[ins.forfait] || FORFAITS.pro;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      locale: 'fr',
      customer_email: ins.email || undefined,
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(f.centimesHT * (1 + TAUX_TVA)),
          recurring: { interval: 'month' },
          product_data: { name: f.nom + (ins.entreprise ? ' — ' + ins.entreprise : ''), description: 'Sans engagement, résiliable à tout moment. Prix TTC (TVA 20 % incluse).' },
        },
        quantity: 1,
      }],
      metadata: { service: 'avis-pro', inscription_id: String(ins.id), forfait: ins.forfait },
      subscription_data: { metadata: { service: 'avis-pro', inscription_id: String(ins.id), forfait: ins.forfait } },
      success_url: 'https://www.skyeco.fr/avis-pro/?paiement=ok#inscription',
      cancel_url: 'https://www.skyeco.fr/avis-pro/?paiement=annule#inscription',
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('avis-pro-checkout :', e.message);
    return res.status(500).json({ error: 'Le paiement n\'a pas pu être préparé. Réessayez dans un instant.' });
  }
}
