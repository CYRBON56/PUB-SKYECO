// /api/contacts-prix-travaux.js
// Administration des contacts gratuits (skyeco.fr/contacts-prix-travaux.html) :
// liste, entreprises compétentes les plus proches (base prospects_paysagiste),
// enregistrement des ventes (3 au maximum par contact) et du statut.
// Protégé par INTERNAL_ACCESS_PASSWORD.
import { sb, METIERS } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

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
