// /api/prix-travaux-confirmer.js
// Appelé par prix-travaux.html au retour du paiement (et depuis le lien de l'email).
// Vérifie le paiement auprès de Stripe, finalise la commande si le webhook ne l'a
// pas encore fait (facture + email), puis renvoie le projet pour l'afficher.

import Stripe from 'stripe';
import { finaliserCommande } from './_lib/prix-travaux-commande.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  const sid = String(req.query.session_id || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sid)) return res.status(400).json({ error: 'Lien invalide' });
  try {
    const session = await stripe.checkout.sessions.retrieve(sid);
    if (session.metadata?.product !== 'prix-travaux') return res.status(400).json({ error: 'Lien invalide' });
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const r = await finaliserCommande(session, origin);
    if (!r.paye) return res.status(200).json({ paye: false });
    const c = r.commande;
    return res.status(200).json({ paye: true, metier: c.metier, reponses: c.reponses, facture: c.facture_numero, email: c.email });
  } catch (e) {
    console.error('prix-travaux-confirmer :', e.message);
    return res.status(500).json({ error: 'Vérification du paiement impossible pour le moment.' });
  }
}
