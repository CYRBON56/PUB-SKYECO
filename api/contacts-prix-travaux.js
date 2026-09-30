// /api/contacts-prix-travaux.js
// Administration des contacts gratuits (skyeco.fr/contacts-prix-travaux.html) :
// liste, entreprises compétentes les plus proches (base prospects_paysagiste),
// enregistrement des ventes (3 au maximum par contact) et du statut.
// Protégé par INTERNAL_ACCESS_PASSWORD.
import { sb, METIERS } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';
import { notifierArtisans } from './_lib/chantiers.js';
import { envoyerLot, statistiques, contenu, SUJET } from './_lib/campagne-chantiers.js';

// Codes d'activité (NAF/APE) des entreprises compétentes pour chaque métier
const APE = {
  toiture: ['4391B', '4391A'], ravalement: ['4334Z', '4399C'], resine: ['4333Z', '4399D'],
  allees: ['4312A', '4211Z', '8130Z'], terrasses: ['4332A', '8130Z', '4333Z'], clotures: ['4332B', '8130Z', '4399D'],
  portails: ['4332B', '4332A'], terrassement: ['4312A', '4312B'], piscine: ['4299Z', '4399C'],
  anc: ['4312A', '4221Z', '3700Z'], isolation: ['4329A', '4331Z'], pac: ['4322B'], menuiseries: ['4332A', '4332B'],
  sdb: ['4322A', '4333Z', '4339Z'], cuisine: ['4332A', '4339Z'], sols: ['4333Z'], peinture: ['4334Z'],
  platrerie: ['4331Z'], electricite: ['4321A'], plomberie: ['4322A', '4322B'],
};
const avecPoint = (c) => c.slice(0, 2) + '.' + c.slice(2);
const MAX_VENTES = 3;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('pt-admin:' + ipDepuisRequete(req), 120, 600))) return res.status(429).json({ error: 'Trop de requêtes.' });
  const { motDePasseInterne, action, id } = req.body || {};
  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) return res.status(401).json({ error: 'Mot de passe interne invalide.' });
  const idOk = typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
  const aid = typeof req.body.artisan_id === 'string' && /^[0-9a-f-]{36}$/.test(req.body.artisan_id) ? req.body.artisan_id : null;
  const achatId = typeof req.body.achat_id === 'string' && /^[0-9a-f-]{36}$/.test(req.body.achat_id) ? req.body.achat_id : null;
  try {
    // ---- Emailing de recrutement des artisans ----
    if (action === 'campagne_stats') return res.status(200).json(await statistiques());
    if (action === 'campagne_reglages') {
      const taille = Math.max(10, Math.min(Number(req.body.taille_lot) || 150, 500));
      const [r] = await sb('campagne_chantiers_reglages?id=eq.1', { method: 'PATCH', body: JSON.stringify({ active: req.body.active === true, taille_lot: taille }) });
      return res.status(200).json(r);
    }
    if (action === 'campagne_envoyer') return res.status(200).json(await envoyerLot({ taille: req.body.taille_lot }));
    if (action === 'campagne_test') {
      const dest = typeof req.body.destinataire === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(req.body.destinataire.trim()) ? req.body.destinataire.trim() : (process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr');
      await envoyerLot({ test: dest });
      return res.status(200).json({ success: true, envoyeA: dest });
    }
    if (action === 'campagne_apercu') {
      const c = contenu({ nom_entreprise: 'Entreprise Exemple SARL', departement: '56' }, 'exemple');
      return res.status(200).json({ success: true, sujet: SUJET, html: c.html.replace(/<img[^>]*>/g, '') });
    }
    // ---- Artisans inscrits et signalements ----
    if (action === 'artisans') {
      const artisans = await sb('artisans_chantiers?select=*&order=created_at.desc&limit=500');
      const achats = await sb('achats_chantiers?select=id,created_at,contact_id,artisan_id,prix_ttc,mode,statut,signale_motif,facture_numero&order=created_at.desc&limit=1000');
      return res.status(200).json({ artisans, achats, metiers: METIERS });
    }
    if (action === 'valider_artisan' && aid) {
      const [a] = await sb(`artisans_chantiers?id=eq.${aid}`, { method: 'PATCH', body: JSON.stringify({ decennale_validee: req.body.valide === true, actif: req.body.actif !== false }) });
      return res.status(200).json({ artisan: a });
    }
    if (action === 'decennale' && aid) {
      const [a] = await sb(`artisans_chantiers?id=eq.${aid}&select=decennale_chemin`);
      if (!a?.decennale_chemin) return res.status(404).json({ error: 'Pas de décennale.' });
      const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/decennales/${a.decennale_chemin}`, { method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) });
      const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j));
      return res.status(200).json({ url: `${process.env.SUPABASE_URL}/storage/v1${j.signedURL}` });
    }
    if ((action === 'rembourser' || action === 'refuser_signalement') && achatId) {
      const [ach] = await sb(`achats_chantiers?id=eq.${achatId}&statut=eq.signale&select=*`);
      if (!ach) return res.status(400).json({ error: 'Aucun signalement en attente pour cet achat.' });
      if (action === 'refuser_signalement') { await sb(`achats_chantiers?id=eq.${achatId}`, { method: 'PATCH', body: JSON.stringify({ statut: 'paye' }) }); return res.status(200).json({ ok: true }); }
      await sb(`achats_chantiers?id=eq.${achatId}`, { method: 'PATCH', body: JSON.stringify({ statut: 'rembourse' }) });
      const [a] = await sb(`artisans_chantiers?id=eq.${ach.artisan_id}&select=credit_gratuit`);
      await sb(`artisans_chantiers?id=eq.${ach.artisan_id}`, { method: 'PATCH', body: JSON.stringify({ credit_gratuit: (a?.credit_gratuit || 0) + 1 }) });
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    console.error('contacts-prix-travaux (artisans) :', e.message);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
  try {
    if (action === 'liste') {
      const contacts = await sb('prix_travaux_contacts?select=*&order=created_at.desc&limit=300');
      return res.status(200).json({ contacts, metiers: METIERS });
    }
    if (!idOk) return res.status(400).json({ error: 'Contact invalide.' });
    const [c] = await sb(`prix_travaux_contacts?id=eq.${id}&select=*`);
    if (!c) return res.status(404).json({ error: 'Contact introuvable.' });

    if (action === 'entreprises') {
      const codes = (APE[c.metier] || []).flatMap((x) => [x, avecPoint(x)]);
      const filtre = `departement=eq.${encodeURIComponent(c.departement)}&code_ape=in.(${codes.map(encodeURIComponent).join(',')})&or=(opt_out.is.null,opt_out.eq.false)`;
      const entreprises = await sb(`prospects_paysagiste?${filtre}&select=id,nom_entreprise,ville,telephone,email,siret,code_ape,site_web&limit=40`);
      return res.status(200).json({ entreprises, codes: APE[c.metier] || [] });
    }
    if (action === 'vendre') {
      const ventes = Array.isArray(c.ventes) ? c.ventes : [];
      if (Array.isArray(c.artisans_choisis)) return res.status(400).json({ error: "Ce particulier choisit lui-même ses entreprises : seules celles qu'il a choisies peuvent prendre son contact, depuis leur lien personnel." });
      if (ventes.length >= MAX_VENTES) return res.status(400).json({ error: 'Ce contact a déjà été vendu à 3 entreprises (maximum promis au particulier).' });
      const entreprise = String(req.body.entreprise || '').trim().slice(0, 120);
      const siret = String(req.body.siret || '').replace(/\D/g, '').slice(0, 14);
      const prix = Math.round(Number(req.body.prix) * 100) / 100;
      if (!entreprise || !(prix >= 0 && prix < 10000)) return res.status(400).json({ error: 'Entreprise ou prix invalide.' });
      if (ventes.some((v) => (siret && v.siret === siret) || v.entreprise === entreprise)) return res.status(400).json({ error: 'Déjà vendu à cette entreprise.' });
      const nouvelles = [...ventes, { entreprise, siret, prix, date: new Date().toISOString() }];
      const [maj] = await sb(`prix_travaux_contacts?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ventes: nouvelles, statut: 'vendu' }) });
      return res.status(200).json({ contact: maj });
    }
    if (action === 'notifier') {
      const n = await notifierArtisans(c);
      return res.status(200).json({ notifies: n });
    }
    if (action === 'statut') {
      const statut = ['nouveau', 'propose', 'vendu', 'sans_suite', 'retrait'].includes(req.body.statut) ? req.body.statut : null;
      const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 1000) : c.note;
      if (!statut) return res.status(400).json({ error: 'Statut invalide.' });
      const [maj] = await sb(`prix_travaux_contacts?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ statut, note }) });
      return res.status(200).json({ contact: maj });
    }
    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    console.error('contacts-prix-travaux :', e.message);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}
