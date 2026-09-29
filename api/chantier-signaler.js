// /api/chantier-signaler.js : l'artisan signale un faux contact (7 jours après l'achat au plus)
import { sb } from './_lib/prix-travaux-commande.js';
import { jetonValide, sms } from './_lib/chantiers.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const { c, a, t, motif } = req.body || {};
  if (!jetonValide(c, a, t)) return res.status(403).json({ error: 'Lien invalide.' });
  const m = ['faux_numero', 'injoignable', 'pas_de_projet', 'autre'].includes(motif) ? motif : null;
  if (!m) return res.status(400).json({ error: 'Choisissez un motif.' });
  try {
    const [achat] = await sb(`achats_chantiers?contact_id=eq.${c}&artisan_id=eq.${a}&statut=eq.paye&select=id,created_at`);
    if (!achat) return res.status(400).json({ error: 'Aucun achat à signaler.' });
    if (Date.now() - new Date(achat.created_at) > 7 * 86400000) return res.status(400).json({ error: 'Le délai de 7 jours pour signaler ce contact est dépassé.' });
    await sb(`achats_chantiers?id=eq.${achat.id}`, { method: 'PATCH', body: JSON.stringify({ statut: 'signale', signale_motif: m }) });
    await sms(process.env.ADMIN_PHONE, `Skyeco : un artisan signale un contact (${m}). À vérifier sur skyeco.fr/artisans-chantiers.html`);
    return res.status(200).json({ ok: true });
  } catch (e) { console.error('chantier-signaler :', e.message); return res.status(500).json({ error: 'Signalement impossible pour le moment.' }); }
}
