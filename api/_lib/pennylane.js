// /api/_lib/pennylane.js
// 16/11/2026 — Petite couche d'accès à l'API publique Pennylane v2, construite
// à partir de la documentation publique (pennylane.readme.io). Plusieurs
// détails (schéma exact des réponses, format du header d'authentification)
// ne sont pas entièrement documentés publiquement : ce module reste donc
// défensif (try/catch, vérification de forme) et ne doit jamais faire
// confiance aveuglément à un champ qui ne serait pas celui attendu.
//
// Variable d'environnement requise : PENNYLANE_API_TOKEN (jeton généré par
// l'artisan dans Pennylane : Paramètres → Connectivité → Développeurs,
// droits « Ventes »). Optionnel : PENNYLANE_COMPANY_ID, pour un jeton de
// cabinet comptable rattaché à plusieurs sociétés (ignoré si le jeton est
// déjà celui d'une seule société).

const BASE = 'https://app.pennylane.com/api/external/v2';

function actif() {
  return !!process.env.PENNYLANE_API_TOKEN;
}

async function appel(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${process.env.PENNYLANE_API_TOKEN}`,
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(process.env.PENNYLANE_COMPANY_ID ? { 'X-Company-Id': process.env.PENNYLANE_COMPANY_ID } : {}),
  };
  const resp = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, { ...options, headers });
  const texte = await resp.text();
  let data = null;
  try { data = texte ? JSON.parse(texte) : null; } catch (e) { /* réponse non JSON (rare, ex: 204) */ }
  if (!resp.ok) {
    const err = new Error(`Pennylane ${resp.status} sur ${path} : ${texte.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// Normalise un nom pour une comparaison insensible à la casse / aux accents.
function normaliser(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Cherche un·e client·e par nom (contient, pas seulement "commence par" —
// l'API ne propose que start_with/eq, donc on filtre nous-mêmes après coup
// sur une liste plus large pour rester tolérant à l'ordre prénom/nom).
async function chercherClients(nom) {
  const n = normaliser(nom);
  if (!n) return [];
  const motsCherches = n.split(/\s+/).filter(Boolean);
  const data = await appel(`/customers?limit=100&sort=-id`);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.filter((c) => {
    const nomClient = normaliser(c.name);
    return motsCherches.some((m) => m.length >= 2 && nomClient.includes(m));
  });
}

async function listerDevisClient(customerId) {
  const filtre = encodeURIComponent(JSON.stringify([{ field: 'customer_id', operator: 'eq', value: customerId }]));
  const data = await appel(`/quotes?limit=30&sort=-id&filter=${filtre}`);
  return Array.isArray(data?.items) ? data.items : [];
}

async function obtenirDevis(id) {
  return appel(`/quotes/${id}`);
}

// Résout un champ "lien" du type {url:"/api/external/v2/quotes/123/invoice_lines"}
// renvoyé par l'API (les lignes d'un devis ne sont pas incluses directement).
async function resoudreLien(lien) {
  if (!lien || !lien.url) return null;
  return appel(lien.url);
}

async function lignesDevis(devis) {
  const data = await resoudreLien(devis.invoice_lines);
  const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  return items;
}

// Taux de TVA français → code Pennylane (ex: 20 → "FR_200"). Les codes
// non-français (exempt, intracom_21, extracom, mixed) ne sont pas couverts :
// on ne les manipule pas automatiquement.
function tauxVersCode(tauxPct) {
  const v = Math.round(Number(tauxPct) * 10);
  if (!Number.isFinite(v) || v < 0 || v > 999) return null;
  return `FR_${String(v).padStart(3, '0')}`;
}
function codeVersTaux(code) {
  const m = /^FR_(\d{1,3})$/.exec(String(code || ''));
  return m ? Number(m[1]) / 10 : null;
}

// Change le taux de TVA de TOUTES les lignes d'un devis existant.
async function changerTvaDevis(devisId, lignesActuelles, nouveauTauxPct) {
  const code = tauxVersCode(nouveauTauxPct);
  if (!code) throw new Error('Taux de TVA non reconnu : ' + nouveauTauxPct);
  const update = lignesActuelles.filter((l) => l && l.id != null).map((l) => ({ id: l.id, vat_rate: code }));
  if (!update.length) throw new Error('Aucune ligne modifiable trouvée sur ce devis.');
  await appel(`/quotes/${devisId}`, { method: 'PUT', body: JSON.stringify({ invoice_lines: { update } }) });
  return obtenirDevis(devisId);
}

async function envoyerDevisParMail(devisId, recipients) {
  const body = recipients && recipients.length ? { recipients } : {};
  await appel(`/quotes/${devisId}/send_by_email`, { method: 'POST', body: JSON.stringify(body) });
}

function ligneAffichage(l) {
  const designation = l.label || l.description || l.title || 'Prestation';
  const qte = l.quantity != null ? Number(l.quantity) : 1;
  const unite = l.unit || 'u';
  const pu = Number(l.raw_currency_unit_price ?? l.unit_price ?? 0) || 0;
  return [String(designation), `${qte} ${unite}`, pu, Math.round(pu * qte * 100) / 100];
}

export {
  actif,
  chercherClients,
  listerDevisClient,
  obtenirDevis,
  lignesDevis,
  changerTvaDevis,
  envoyerDevisParMail,
  tauxVersCode,
  codeVersTaux,
  ligneAffichage,
  normaliser,
};
