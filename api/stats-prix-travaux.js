// /api/stats-prix-travaux.js
// Données du tableau de bord skyeco.fr/stats-prix-travaux.html :
// Google Ads (via Windsor.ai) + parcours sur le site + ventes réelles (Supabase)
// + dernier audit de l'agent. Protégé par le mot de passe interne (INTERNAL_ACCESS_PASSWORD).
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const COMPTE = '784-990-3984', CAMPAGNE_ID = '24304238293', LANCEMENT = '2026-09-28';
const GROUPES = { '200910235655': 'toiture', '209057891228': 'pac', '204219133121': 'isolation', '200910239975': 'menuiseries', '204351643327': 'ravalement', '199322283783': 'sdb' };

async function windsor(fields, du, au) {
  try {
    const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', CAMPAGNE_ID]]));
    const r = await fetch(`https://connectors.windsor.ai/google_ads?api_key=${process.env.WINDSOR_API_KEY}&accounts=${encodeURIComponent(COMPTE)}&fields=${fields.join(',')}&filter=${filtre}&date_from=${du}&date_to=${au}`);
    const j = await r.json(); return r.ok && Array.isArray(j.data) ? j.data : [];
  } catch { return []; }
}
async function sb(path) {
  const K = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: K, Authorization: `Bearer ${K}` } });
  return r.ok ? r.json() : [];
}
const n = (v) => Number(v) || 0;
function grouper(lignes, cle) {
  const m = {};
  for (const l of lignes) { const k = typeof cle === 'function' ? cle(l) : l[cle]; if (!k) continue; m[k] = m[k] || { cle: k, clics: 0, impressions: 0, cout: 0 }; m[k].clics += n(l.clicks); m[k].impressions += n(l.impressions); m[k].cout += n(l.cost); }
  return Object.values(m).map((x) => ({ ...x, cout: Math.round(x.cout * 100) / 100 }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('pt-stats:' + ipDepuisRequete(req), 60, 600))) return res.status(429).json({ error: 'Trop de requêtes, patientez quelques minutes.' });
  const { motDePasseInterne, periode } = req.body || {};
  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) return res.status(401).json({ error: 'Mot de passe interne invalide.' });

  const auj = new Date(), jour = (d) => d.toISOString().slice(0, 10);
  const jours = { aujourdhui: 0, '7j': 6, '30j': 29 }[periode];
  const du = jours === undefined ? LANCEMENT : jour(new Date(auj - jours * 86400000));
  const au = jour(auj);

  const [quotidien, groupes, regions, villes, termes, commandes, evenements, audits] = await Promise.all([
    windsor(['date', 'clicks', 'impressions', 'cost'], du, au),
    windsor(['ad_group_id', 'clicks', 'impressions', 'cost'], du, au),
    windsor(['geo_target_region', 'clicks', 'cost'], du, au),
    windsor(['geo_target_city', 'clicks', 'cost'], du, au),
    windsor(['ad_group_id', 'search_term_view_search_term', 'clicks', 'impressions', 'cost'], du, au),
    sb(`prix_travaux_commandes?created_at=gte.${du}&select=metier,statut,montant_ttc,created_at,paye_le`),
    sb(`prix_travaux_evenements?created_at=gte.${du}&select=type,metier,pub,created_at&limit=20000`),
    sb('agent_prix_travaux_audits?select=created_at,synthese,actions&order=created_at.desc&limit=1'),
  ]);

  const payees = commandes.filter((c) => c.statut === 'payee' || c.statut === 'erreur');
  const parMetier = grouper(groupes, (l) => GROUPES[String(l.ad_group_id)]).map((g) => {
    const ventes = payees.filter((c) => c.metier === g.cle).length;
    return { ...g, ventes, coutParVente: ventes ? Math.round((g.cout / ventes) * 100) / 100 : null };
  });
  const tot = (k) => Math.round(parMetier.reduce((a, g) => a + g[k], 0) * 100) / 100;
  const compte = (t) => evenements.filter((e) => e.type === t).length;
  const ventesParJour = {};
  for (const c of payees) { const d = (c.paye_le || c.created_at).slice(0, 10); ventesParJour[d] = (ventesParJour[d] || 0) + 1; }

  return res.status(200).json({
    periode: { du, au }, majLe: new Date().toISOString(),
    kpis: { clics: tot('clics'), impressions: tot('impressions'), cout: tot('cout'), ventes: payees.length, ca: Math.round(payees.reduce((a, c) => a + n(c.montant_ttc), 0) * 100) / 100 },
    entonnoir: { clicsPub: tot('clics'), visites: compte('visite'), visitesPub: evenements.filter((e) => e.type === 'visite' && e.pub).length, fourchettes: compte('fourchette'), clicsPayer: compte('clic_payer'), paiementsCommences: commandes.length, ventes: payees.length },
    quotidien: grouper(quotidien, 'date').sort((a, b) => a.cle.localeCompare(b.cle)).map((d) => ({ ...d, ventes: ventesParJour[d.cle] || 0 })),
    parMetier: parMetier.sort((a, b) => b.clics - a.clics),
    regions: grouper(regions, 'geo_target_region').sort((a, b) => b.clics - a.clics),
    villes: grouper(villes, 'geo_target_city').sort((a, b) => b.clics - a.clics).slice(0, 15),
    termes: termes.filter((t) => t.search_term_view_search_term).map((t) => ({ recherche: t.search_term_view_search_term, metier: GROUPES[String(t.ad_group_id)], clics: n(t.clicks), impressions: n(t.impressions), cout: Math.round(n(t.cost) * 100) / 100 }))
      .sort((a, b) => b.clics - a.clics || b.impressions - a.impressions).slice(0, 40),
    dernierAudit: audits[0] || null,
  });
}
