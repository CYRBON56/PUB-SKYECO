// /api/prix-travaux-evenement.js
// Compteur anonyme du parcours sur prix-travaux.html (visite, fourchette affichée,
// clic sur « Payer »), pour l'entonnoir du tableau de bord. Aucune donnée
// personnelle, aucun cookie : seulement le type d'étape, le métier et l'origine pub.
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const TYPES = ['visite', 'fourchette', 'clic_payer', 'contact_gratuit', 'clic_gratuit', 'formulaire_incomplet', 'code_demande', 'code_echec', 'code_invalide', 'choix_entreprises', 'clic_apercu', 'apercu_depot', 'apercu_echec', 'clic_payer_apercu'];
// 'apercu_ok' n'est volontairement pas accepté ici : il est écrit par le serveur
// (prix-travaux-analyser-devis) et sert de plafond quotidien des aperçus gratuits.
const METIERS = ['toiture','ravalement','resine','allees','terrasses','clotures','portails','terrassement','piscine','anc','isolation','pac','menuiseries','sdb','cuisine','sols','peinture','platrerie','electricite','plomberie'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  const type = b?.type, metier = METIERS.includes(b?.metier) ? b.metier : null;
  if (!TYPES.includes(type)) return res.status(400).end();
  if (!(await verifierLimite('pt-evt:' + ipDepuisRequete(req), 40, 600))) return res.status(204).end();
  const K = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/prix_travaux_evenements`, {
      method: 'POST', headers: { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, metier, pub: b?.pub === true }),
    });
  } catch {}
  return res.status(204).end();
}
