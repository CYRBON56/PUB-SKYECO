// /api/precommande-confirmer.js
// 09/10/2026 — Appelé au retour du paiement : vérifie la session Stripe et
// finalise la précommande (le webhook prix-travaux-webhook le fait aussi).

import Stripe from 'stripe';
import { finaliserPrecommande } from './_lib/precommande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (!(await verifierLimite('preco-conf:' + ipDepuisRequete(req), 30, 600))) return res.status(429).json({ error: 'Trop de tentatives.' });
  const sid = String(req.query.session_id || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sid)) return res.status(400).json({ error: 'Lien invalide' });
  try {
    const session = await stripe.checkout.sessions.retrieve(sid);
    if (session.metadata?.product !== 'precommande') return res.status(400).json({ error: 'Lien invalide' });
    const r = await finaliserPrecommande(session);
    return res.status(200).json({ paye: r.paye, email: r.precommande?.email || null });
  } catch (e) {
    if (e?.code === 'resource_missing') return res.status(404).json({ error: 'Lien invalide' });
    console.error('precommande-confirmer :', e.message);
    return res.status(500).json({ error: 'Vérification du paiement impossible pour le moment.' });
  }
}
