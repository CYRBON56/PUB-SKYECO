// /api/prix-travaux-choix.js (30/09/2026)
// Option gratuite de prix-travaux.html : après vérification SMS, le particulier voit les
// entreprises vérifiées de son secteur (adresse, SIRET, décennale vérifiée) et choisit
// celles qui peuvent le contacter (3 au maximum). Seules celles-là sont alertées et
// peuvent prendre le contact (contrôle aussi dans la fonction SQL reserver_chantier).
import { sb } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';
import { jetonClientValide, artisansEligibles, notifierArtisans } from './_lib/chantiers.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('pt-choix:' + ipDepuisRequete(req), 20, 600))) return res.status(429).json({ error: 'Trop de tentatives.' });
  const { contact_id: c, jeton, artisans } = req.body || {};
  if (!jetonClientValide(c, jeton)) return res.status(403).json({ error: 'Lien invalide. Rechargez la page.' });
  const demandes = [...new Set(Array.isArray(artisans) ? artisans.map(String) : [])];
  if (!demandes.length) return res.status(400).json({ error: 'Cochez au moins une entreprise.' });
  if (demandes.length > 3) return res.status(400).json({ error: 'Choisissez 3 entreprises au maximum.' });
  try {
    const [contact] = await sb(`prix_travaux_contacts?id=eq.${c}&select=*`);
    if (!contact) return res.status(404).json({ error: 'Demande introuvable.' });
    if (Array.isArray(contact.artisans_choisis) && contact.artisans_choisis.length) return res.status(200).json({ ok: true, deja: true });
    const permis = new Set((await artisansEligibles(contact)).map((a) => a.id));
    const choix = demandes.filter((id) => permis.has(id));
    if (!choix.length) return res.status(400).json({ error: "Ces entreprises ne sont plus disponibles. Rechargez la page." });
    const [maj] = await sb(`prix_travaux_contacts?id=eq.${c}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ artisans_choisis: choix, choix_le: new Date().toISOString() }) });
    await notifierArtisans(maj).catch((e) => console.error('notifierArtisans :', e.message));
    return res.status(200).json({ ok: true, nb: choix.length });
  } catch (e) {
    console.error('prix-travaux-choix :', e.message);
    return res.status(500).json({ error: "L'envoi a échoué. Réessayez dans un instant." });
  }
}
