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

// Le jeton peut venir soit du compte de l'artisan (stocké côté serveur, par
// artisan — voir /api/pennylane-connecter.js), soit, à défaut, de la variable
// d'environnement globale PENNYLANE_API_TOKEN (compatibilité / compte unique).
// Chaque fonction accepte un `token` en dernier paramètre, optionnel : on ne
// garde JAMAIS le jeton dans une variable de module, pour qu'un jeton d'un
// artisan ne puisse pas se retrouver utilisé pour un autre.
function actif(token) {
  return !!(token || process.env.PENNYLANE_API_TOKEN);
}

async function appel(path, token, options = {}) {
  const jeton = token || process.env.PENNYLANE_API_TOKEN;
  const headers = {
    Authorization: `Bearer ${jeton}`,
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
async function chercherClients(nom, token) {
  const n = normaliser(nom);
  if (!n) return [];
  const motsCherches = n.split(/\s+/).filter(Boolean);
  const data = await appel(`/customers?limit=100&sort=-id`, token);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.filter((c) => {
    const nomClient = normaliser(c.name);
    return motsCherches.some((m) => m.length >= 2 && nomClient.includes(m));
  });
}

async function listerDevisClient(customerId, token) {
  const filtre = encodeURIComponent(JSON.stringify([{ field: 'customer_id', operator: 'eq', value: customerId }]));
  const data = await appel(`/quotes?limit=30&sort=-id&filter=${filtre}`, token);
  return Array.isArray(data?.items) ? data.items : [];
}

async function obtenirDevis(id, token) {
  return appel(`/quotes/${id}`, token);
}

// Résout un champ "lien" du type {url:"/api/external/v2/quotes/123/invoice_lines"}
// renvoyé par l'API (les lignes d'un devis ne sont pas incluses directement).
async function resoudreLien(lien, token) {
  if (!lien || !lien.url) return null;
  return appel(lien.url, token);
}

async function lignesDevis(devis, token) {
  const data = await resoudreLien(devis.invoice_lines, token);
  const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  return items;
}

// Vérifie qu'un jeton est réellement valide auprès de Pennylane, sans rien
// modifier (simple lecture d'un client max). Utilisé à la connexion de
// l'artisan, pour ne JAMAIS marquer « Connecté » sur la base d'un jeton non
// vérifié. Renvoie {ok:true} ou {ok:false, erreur}.
async function validerToken(token) {
  if (!token || typeof token !== 'string' || token.trim().length < 10) {
    return { ok: false, erreur: 'Jeton manquant ou trop court.' };
  }
  try {
    await appel('/customers?limit=1', token.trim());
    return { ok: true };
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return { ok: false, erreur: "Ce jeton n'est pas accepté par Pennylane (vérifiez qu'il a bien les droits « Ventes »)." };
    }
    return { ok: false, erreur: "Pennylane n'a pas répondu correctement pour le moment." };
  }
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
async function changerTvaDevis(devisId, lignesActuelles, nouveauTauxPct, token) {
  const code = tauxVersCode(nouveauTauxPct);
  if (!code) throw new Error('Taux de TVA non reconnu : ' + nouveauTauxPct);
  const update = lignesActuelles.filter((l) => l && l.id != null).map((l) => ({ id: l.id, vat_rate: code }));
  if (!update.length) throw new Error('Aucune ligne modifiable trouvée sur ce devis.');
  await appel(`/quotes/${devisId}`, token, { method: 'PUT', body: JSON.stringify({ invoice_lines: { update } }) });
  return obtenirDevis(devisId, token);
}

async function envoyerDevisParMail(devisId, recipients, token) {
  const body = recipients && recipients.length ? { recipients } : {};
  await appel(`/quotes/${devisId}/send_by_email`, token, { method: 'POST', body: JSON.stringify(body) });
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
  validerToken,
  tauxVersCode,
  codeVersTaux,
  ligneAffichage,
  normaliser,
};
