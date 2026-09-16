// scripts/collecte-pros-batiment.js
//
// Pipeline en 2 étapes, 100% gratuit :
//
// 1. Liste les entreprises du bâtiment via l'API SIRENE officielle
//    (recherche-entreprises.api.gouv.fr, gratuite, sans clé, 7 req/s max) —
//    filtrée par code métier (APE) et département. Cette base ne contient
//    JAMAIS d'email ni de site web, seulement SIRET/nom/adresse/activité.
//
// 2. Pour chaque entreprise, tente de trouver son site web (recherche
//    DuckDuckGo HTML, pas de clé requise) puis scrape sa page d'accueil et
//    sa page contact/mentions-légales pour en extraire un email.
//    ATTENTION : cette étape n'est pas garantie — DuckDuckGo peut bloquer
//    en cas d'usage trop intensif (mettre des pauses, ne pas paralléliser),
//    et beaucoup de petits artisans n'ont pas de site indexé. Comptez un
//    taux de réussite de l'ordre de 15-30% selon les métiers, pas plus.
//
// Résultat : un fichier .xlsx avec un onglet PAR CODE MÉTIER (APE), colonnes
// SIRET / Raison sociale / Adresse / CP / Ville / Site web / Email / Statut.
//
// Usage :
//   npm install xlsx
//   node scripts/collecte-pros-batiment.js
//
// Réglages tout en haut du fichier (codes APE, départements, volume).

import * as XLSX from 'xlsx';
import fs from 'fs';

// ---------------------------------------------------------------------------
// RÉGLAGES — à ajuster avant de lancer
// ---------------------------------------------------------------------------

// Codes APE bâtiment courants (libellé = onglet Excel). Complète/retire
// selon ce qui t'intéresse.
const METIERS = {
  '4399D': 'Autres travaux spécialisés (résine, étanchéité...)',
  '4321A': "Travaux d'installation électrique",
  '4322A': "Travaux d'installation eau et gaz",
  '4322B': "Installations thermiques / climatisation",
  '4391A': 'Travaux de charpente',
  '4391B': 'Travaux de couverture',
  '4120A': 'Construction de maisons individuelles',
  '4120B': "Construction d'autres bâtiments",
  '4399C': 'Maçonnerie générale / gros œuvre',
  '4333Z': 'Revêtement des sols et des murs',
  '4334Z': 'Peinture et vitrerie',
  '4332A': 'Menuiserie bois et PVC',
  '4332B': 'Menuiserie métallique / serrurerie',
  '4339Z': 'Autres travaux de finition',
  '4312A': 'Terrassement courants',
};

// Départements ciblés (mets ["all"] pour ne pas filtrer géographiquement —
// attention, ça multiplie fortement le volume).
const DEPARTEMENTS = ['56', '29', '22', '35', '44'];

// Nombre max de pages SIRENE par (métier x département) — 25 résultats par
// page. 20 pages = jusqu'à 500 entreprises par croisement métier/département.
const MAX_PAGES_SIRENE = 20;

// Pause entre deux recherches DuckDuckGo (ms) — reste raisonnable pour ne
// pas se faire bloquer. Ne pas descendre sous 1000ms.
const PAUSE_RECHERCHE_MS = 1500;

// Fichier CSV optionnel listant les emails déjà connus (une adresse par
// ligne) pour ne pas les rechercher/lister une deuxième fois.
const FICHIER_EMAILS_EXISTANTS = './emails-existants.csv';

// ---------------------------------------------------------------------------

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

function chargerEmailsExistants() {
  if (!fs.existsSync(FICHIER_EMAILS_EXISTANTS)) return new Set();
  const lignes = fs.readFileSync(FICHIER_EMAILS_EXISTANTS, 'utf8').split('\n');
  return new Set(lignes.map((l) => l.trim().toLowerCase()).filter(Boolean));
}

// --- Étape 1 : liste SIRENE par métier + département -----------------------

async function listerEntreprises(codeApe, departement) {
  const resultats = [];
  for (let page = 1; page <= MAX_PAGES_SIRENE; page++) {
    const url = `https://recherche-entreprises.api.gouv.fr/search?activite_principale=${codeApe}&departement=${departement}&page=${page}&per_page=25&minimal=true`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) break;
    const data = await resp.json();
    const lot = data.results || [];
    if (!lot.length) break;
    for (const e of lot) {
      const siege = e.siege || {};
      resultats.push({
        siret: siege.siret || e.siren,
        raisonSociale: e.nom_complet || e.nom_raison_sociale || '',
        adresse: siege.adresse || '',
        codePostal: siege.code_postal || '',
        ville: siege.libelle_commune || '',
      });
    }
    if (lot.length < 25) break; // dernière page atteinte
    await dormir(150); // reste sous 7 req/s
  }
  return resultats;
}

// --- Étape 2 : recherche du site web + email --------------------------------

function extraireEmails(html) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const trouves = (html.match(regex) || [])
    .map((e) => e.toLowerCase())
    .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(e))
    .filter((e) => !e.includes('wixpress') && !e.includes('sentry') && !e.includes('example.'));
  return [...new Set(trouves)];
}

async function chercherSiteWeb(raisonSociale, ville) {
  const requete = encodeURIComponent(`${raisonSociale} ${ville}`);
  const resp = await fetch(`https://html.duckduckgo.com/html/?q=${requete}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RechercheProBTP/1.0)' },
  });
  if (!resp.ok) return null;
  const html = await resp.text();
  // Les liens DuckDuckGo HTML sont de la forme //duckduckgo.com/l/?uddg=<url encodée>
  const matches = [...html.matchAll(/uddg=([^&"]+)/g)].map((m) => decodeURIComponent(m[1]));
  const exclus = /facebook\.|linkedin\.|pagesjaunes\.|societe\.com|pappers\.fr|instagram\.|google\./i;
  return matches.find((u) => !exclus.test(u)) || null;
}

async function trouverEmailEntreprise(entreprise) {
  try {
    const site = await chercherSiteWeb(entreprise.raisonSociale, entreprise.ville);
    if (!site) return { site: null, email: null, statut: 'site_non_trouve' };

    const pagesAEssayer = [site, site.replace(/\/?$/, '/contact'), site.replace(/\/?$/, '/mentions-legales')];
    for (const pageUrl of pagesAEssayer) {
      try {
        const resp = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!resp.ok) continue;
        const html = await resp.text();
        const emails = extraireEmails(html);
        if (emails.length) return { site, email: emails[0], statut: 'trouve' };
      } catch { /* page suivante */ }
    }
    return { site, email: null, statut: 'site_trouve_sans_email' };
  } catch (err) {
    return { site: null, email: null, statut: 'erreur: ' + err.message };
  }
}

// --- Orchestration -----------------------------------------------------------

async function main() {
  const emailsExistants = chargerEmailsExistants();
  const classeur = XLSX.utils.book_new();

  for (const [codeApe, libelle] of Object.entries(METIERS)) {
    console.log(`\n=== ${codeApe} — ${libelle} ===`);
    let entreprisesMetier = [];

    for (const dep of DEPARTEMENTS) {
      console.log(`  département ${dep}...`);
      const lot = await listerEntreprises(codeApe, dep);
      entreprisesMetier.push(...lot);
      await dormir(200);
    }

    // Déduplication par SIRET.
    const vues = new Set();
    entreprisesMetier = entreprisesMetier.filter((e) => {
      if (vues.has(e.siret)) return false;
      vues.add(e.siret);
      return true;
    });

    console.log(`  ${entreprisesMetier.length} entreprises trouvées, recherche d'email en cours...`);

    const lignes = [];
    for (const ent of entreprisesMetier) {
      const { site, email, statut } = await trouverEmailEntreprise(ent);
      if (email && emailsExistants.has(email)) {
        lignes.push({ ...ent, site, email, statut: 'deja_connu' });
      } else {
        lignes.push({ ...ent, site, email, statut });
      }
      await dormir(PAUSE_RECHERCHE_MS);
    }

    const feuille = XLSX.utils.json_to_sheet(lignes.map((l) => ({
      SIRET: l.siret,
      'Raison sociale': l.raisonSociale,
      Adresse: l.adresse,
      'Code postal': l.codePostal,
      Ville: l.ville,
      'Site web': l.site || '',
      Email: l.email || '',
      Statut: l.statut,
    })));
    // Nom d'onglet Excel limité à 31 caractères.
    const nomOnglet = (codeApe + ' ' + libelle).slice(0, 31);
    XLSX.utils.book_append_sheet(classeur, feuille, nomOnglet);

    const avecEmail = lignes.filter((l) => l.email && l.statut !== 'deja_connu').length;
    console.log(`  -> ${avecEmail} nouveaux emails trouvés sur ${entreprisesMetier.length}.`);
  }

  const nomFichier = `pros-batiment-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(classeur, nomFichier);
  console.log(`\nTerminé — fichier généré : ${nomFichier}`);
}

main().catch((err) => { console.error('Erreur fatale :', err); process.exit(1); });
