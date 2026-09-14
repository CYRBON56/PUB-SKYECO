// /api/_lib/meta-ads.js
// Client minimal pour la Marketing API de Meta (Facebook/Instagram Ads),
// utilisé par create-meta-ads-campaign.js.
//
// ARCHITECTURE DÉCIDÉE AVEC CYRILLE LE 14/09/2026 (voir le brief projet
// claude/skyeco-pro-brief-meta-ads-architecture.md pour le détail et les
// sources) : contrairement à Google Ads (où chaque artisan a son PROPRE
// compte client créé sous le MCC Skyeco Pro), Meta Ads utilise UN SEUL
// compte publicitaire partagé (celui de Skyeco Pro / RMS EcoSky), avec UNE
// CAMPAGNE dédiée par artisan à l'intérieur. Raison : un nouveau Business
// Manager Meta ne peut créer qu'1 seul compte publicitaire tant qu'il n'a
// pas d'historique de paiement confirmé (limite qui augmente ensuite de
// façon progressive et opaque), et la création automatisée et rapide de
// comptes publicitaires est un signal que Meta surveille activement pour
// restreindre des comptes — reproduire l'architecture Google Ads (un compte
// pub par artisan) exposerait TOUS les artisans à un risque de blocage du
// Business Manager entier. La création de CAMPAGNES, en revanche, n'a pas
// cette limite — c'est l'usage normal et attendu d'un compte publicitaire
// actif.
//
// Variables d'environnement requises :
//   META_ADS_ACCESS_TOKEN   (jeton système utilisateur de longue durée,
//                            généré depuis Business Manager > Utilisateurs
//                            système, avec les permissions ads_management +
//                            pages_read_engagement sur l'App Marketing API)
//   META_AD_ACCOUNT_ID      (l'ID du compte pub Skyeco Pro, SANS le préfixe
//                            "act_" — ex. "123456789012345")
//   META_PAGE_ID            (la Page Facebook au nom de laquelle les
//                            annonces sont publiées — probablement la Page
//                            "Ecosky", ID 243043852219845, déjà utilisée
//                            pour les campagnes RMS EcoSky existantes, à
//                            confirmer avec Cyrille avant le premier test)
//
// Version de l'API : v21.0 (celle déjà utilisée ailleurs dans ce projet
// pour Facebook/Instagram — voir api/facebook-callback.js,
// api/social-publish.js — pour rester cohérent ; si un appel échoue un jour
// avec une erreur mentionnant une version dépréciée, vérifier la version
// courante sur https://developers.facebook.com/docs/graph-api/changelog).

const API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;

function idCompte() {
  const id = String(process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, '');
  if (!id) throw new Error('META_AD_ACCOUNT_ID manquant');
  return `act_${id}`;
}

// Appel générique à la Marketing API — POST (création) par défaut, GET pour
// les recherches (ex. suggestions d'intérêts). `params` est un objet JS,
// converti en form-urlencoded (POST) ou en query string (GET) — la Graph
// API accepte les deux pour les valeurs simples ; les objets/tableaux
// (targeting, object_story_spec…) doivent être passés déjà en JSON.stringify
// par l'appelant avant d'être mis dans `params`.
async function appelMetaAds(path, params = {}, method = 'POST') {
  const token = process.env.META_ADS_ACCESS_TOKEN;
  if (!token) throw new Error('META_ADS_ACCESS_TOKEN manquant');

  const url = new URL(`${GRAPH_BASE}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });

  const resp = method === 'GET'
    ? await fetch(`${url.toString()}?${body.toString()}`)
    : await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

  const data = await resp.json();
  if (!resp.ok || data.error) {
    const err = data.error || {};
    throw new Error(`Meta Ads API (${path}) : ${err.message || resp.statusText} (code ${err.code || '?'}, sous-code ${err.error_subcode || '?'})`);
  }
  return data;
}

// Recherche d'intérêts de ciblage à partir d'un mot-clé libre (ex. "jardinage",
// "paysagisme") — remplace un mapping figé métier → IDs d'intérêts (les IDs
// Meta ne sont pas stables/documentés publiquement, mieux vaut les résoudre
// dynamiquement à chaque création de campagne). Retourne au plus `limite`
// intérêts {id, name}. En cas d'échec (mot-clé sans correspondance, erreur
// API), retourne un tableau vide plutôt que de faire échouer la création de
// campagne — le ciblage géographique seul reste valable sans intérêts.
async function chercherInterets(motCle, limite = 3) {
  try {
    const data = await appelMetaAds('search', {
      type: 'adinterest',
      q: motCle,
      limit: String(limite),
    }, 'GET');
    return Array.isArray(data.data) ? data.data.slice(0, limite).map(i => ({ id: i.id, name: i.name })) : [];
  } catch (e) {
    return [];
  }
}

export { appelMetaAds, chercherInterets, idCompte, API_VERSION };
