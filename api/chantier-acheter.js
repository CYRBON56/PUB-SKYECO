// /api/chantier-acheter.js : un artisan prend un chantier (offert s'il lui reste un crédit, sinon paiement Stripe)
import Stripe from 'stripe';
import { sb, METIERS } from './_lib/prix-travaux-commande.js';
import { jetonValide, prixChantier, finaliserAchat } from './_lib/chantiers.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('ch-achat:' + ipDepuisRequete(req), 20, 600))) return res.status(429).json({ error: 'Trop de tentatives.' });
  const { c, a, t } = req.body || {};
  if (!jetonValide(c, a, t)) return res.status(403).json({ error: 'Lien invalide.' });
  try {
    const [artisan] = await sb(`artisans_chantiers?id=eq.${a}&select=*`);
    const [contact] = await sb(`prix_travaux_contacts?id=eq.${c}&select=id,metier,code_postal`);
    if (!artisan || !contact) return res.status(404).json({ error: 'Chantier introuvable.' });
    if (!artisan.actif || !artisan.decennale_validee) return res.status(403).json({ error: 'Votre compte est en cours de validation.' });
    const gratuit = artisan.credit_gratuit > 0, prix = gratuit ? 0 : prixChantier(contact.metier);
    const r = await sb('rpc/reserver_chantier', { method: 'POST', body: JSON.stringify({ p_contact: c, p_artisan: a, p_prix: prix, p_mode: gratuit ? 'gratuit' : 'stripe' }) });
    if (r.etat === 'complet') return res.status(409).json({ error: 'Trop tard : 3 entreprises ont déjà pris ce chantier.' });
    if (r.etat === 'indisponible') return res.status(409).json({ error: "Ce chantier n'est plus disponible." });
    if (r.etat === 'deja') return res.status(200).json({ ok: true });
    if (gratuit) {
      const dec = await sb(`artisans_chantiers?id=eq.${a}&credit_gratuit=gt.0`, { method: 'PATCH', body: JSON.stringify({ credit_gratuit: artisan.credit_gratuit - 1 }) });
      if (!dec.length) return res.status(409).json({ error: 'Votre chantier offert a déjà été utilisé. Rechargez la page.' });
      await finaliserAchat(r.achat_id);
      return res.status(200).json({ ok: true });
    }
    const origin = 'https://www.skyeco.fr', base = `${origin}/chantier.html?c=${c}&a=${a}&t=${t}`;
    const session = await new Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.create({
      mode: 'payment', payment_method_types: ['card'], locale: 'fr', customer_email: artisan.email,
      line_items: [{ price_data: { currency: 'eur', unit_amount: Math.round(prix * 100), product_data: { name: `Chantier ${METIERS[contact.metier]} (${contact.code_postal})`, description: 'Coordonnées d\'un particulier vérifié par SMS. TVA 20 % incluse. Facture envoyée par email.' } }, quantity: 1 }],
      metadata: { product: 'chantier', achat_id: r.achat_id, contact_id: c, artisan_id: a },
      success_url: `${base}&session_id={CHECKOUT_SESSION_ID}`, cancel_url: base,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('chantier-acheter :', e.message);
    return res.status(500).json({ error: 'Achat impossible pour le moment.' });
  }
}
