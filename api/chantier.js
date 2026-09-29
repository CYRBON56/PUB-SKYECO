// /api/chantier.js : fiche d'un chantier pour un artisan (lien personnel sécurisé),
// et finalisation après paiement Stripe (retour avec session_id).
import Stripe from 'stripe';
import { sb, METIERS } from './_lib/prix-travaux-commande.js';
import { jetonValide, resumeAnonyme, prixChantier, finaliserAchat, MAX_ACHETEURS } from './_lib/chantiers.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

export default async function handler(req, res) {
  if (!(await verifierLimite('ch-voir:' + ipDepuisRequete(req), 60, 600))) return res.status(429).json({ error: 'Trop de requêtes.' });
  const { c, a, t, session_id } = req.query;
  if (!jetonValide(c, a, t)) return res.status(403).json({ error: 'Lien invalide.' });
  try {
    if (session_id) {
      const s = await new Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.retrieve(String(session_id));
      if (s.metadata?.product === 'chantier' && s.metadata.contact_id === c && s.metadata.artisan_id === a && s.payment_status === 'paid') await finaliserAchat(s.metadata.achat_id, s);
    }
    const [contact] = await sb(`prix_travaux_contacts?id=eq.${c}&select=*`);
    const [artisan] = await sb(`artisans_chantiers?id=eq.${a}&select=id,entreprise,credit_gratuit,decennale_validee,actif`);
    if (!contact || !artisan) return res.status(404).json({ error: 'Chantier introuvable.' });
    const achats = await sb(`achats_chantiers?contact_id=eq.${c}&select=id,artisan_id,statut,created_at`);
    const vivants = achats.filter((x) => x.statut === 'paye' || x.statut === 'signale' || (x.statut === 'reserve' && Date.now() - new Date(x.created_at) < 30 * 60000));
    const mien = achats.find((x) => x.artisan_id === a && ['paye', 'signale', 'rembourse'].includes(x.statut));
    const r = {
      metier: METIERS[contact.metier], resume: resumeAnonyme(contact), date: contact.created_at,
      placesRestantes: Math.max(0, MAX_ACHETEURS - vivants.length),
      prix: prixChantier(contact.metier), gratuitDisponible: artisan.credit_gratuit > 0,
      disponible: !['retrait', 'sans_suite'].includes(contact.statut), entreprise: artisan.entreprise, compteValide: artisan.decennale_validee && artisan.actif,
      achete: !!mien, statutAchat: mien?.statut || null,
    };
    if (mien) Object.assign(r, { client: { nom: `${contact.prenom} ${contact.nom}`, telephone: contact.telephone, email: contact.email, lieu: `${contact.commune || ''} ${contact.code_postal}`.trim() }, signalableJusquau: new Date(new Date(mien.created_at).getTime() + 7 * 86400000).toISOString() });
    return res.status(200).json(r);
  } catch (e) {
    console.error('chantier :', e.message);
    return res.status(500).json({ error: 'Chantier momentanément indisponible.' });
  }
}
