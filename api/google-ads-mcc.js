// /api/_lib/google-ads-mcc.js
// Client minimal pour l'API Google Ads (REST, v25) — utilisé UNIQUEMENT
// pour ce que Windsor.ai ne sait pas faire : créer un nouveau compte client
// Google Ads sous le MCC Skyeco Pro (735-335-0497). Windsor.ai reste
// utilisé partout ailleurs (create-google-ads-campaign.js pour le contenu
// des campagnes, estimate-reach.js, clics-par-zone.js) — vérifié le
// 10/09/2026 : la liste complète des actions Windsor.ai pour google_ads
// (list_actions) ne contient AUCUNE action de création de compte, donc ce
// module comble ce seul manque.
//
// Mis en place le 10/09/2026 avec Cyrille : Client ID/Secret OAuth2
// ("Skyeco OAuth Playground", projet Google Cloud "Skyeco Pro AP") +
// Refresh Token obtenu via OAuth Playground (scope
// https://www.googleapis.com/auth/adwords, autorisé par
// boncyrille56@gmail.com, qui administre le MCC).
//
// Variables d'environnement requises :
//   GOOGLE_ADS_OAUTH_CLIENT_ID
//   GOOGLE_ADS_OAUTH_CLIENT_SECRET
//   GOOGLE_ADS_OAUTH_REFRESH_TOKEN
//   GOOGLE_ADS_DEVELOPER_TOKEN   (Google Ads > Centre API, MCC 735-335-0497)
//   GOOGLE_ADS_MCC_ID            (7353350497 ou 735-335-0497, avec ou sans tirets)
//
// ATTENTION (à vérifier au premier test réel, voir le commentaire dans
// create-google-ads-campaign.js) : le Developer Token de ce projet avait
// été obtenu avec le niveau d'accès le plus bas ("Explorer"/Test access),
// qui bloquait déjà un appel direct à l'API le 31/08/2026 pour un autre
// endpoint (voir l'historique d'estimate-reach.js). Si ce niveau n'a pas
// été relevé depuis (accès Basic ou Standard), TOUT appel de ce module sur
// un compte réel (pas un "compte de test" Google Ads) échouera avec une
// erreur explicite du type "Test developer tokens can only be used with
// test accounts." — pas un bug de ce code, une limitation de compte côté
// Google à faire lever (Centre API > demander l'accès Basic).
//
// Version de l'API : v25 (confirmée en vigueur le 10/09/2026 — Google fait
// sauter les anciennes versions environ tous les ans ; si un appel échoue
// un jour avec une erreur mentionnant une version dépréciée, il suffira de
// changer API_VERSION ci-dessous après avoir vérifié la version courante
// sur https://developers.google.com/google-ads/api/docs/release-notes).

const API_VERSION = 'v25';
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

function idSansTirets(id) {
  return String(id || '').replace(/[^0-9]/g, '');
}

// Le jeton d'accès expire au bout d'environ 1h — vu que chaque invocation
// Vercel est un processus à court terme, ce cache en mémoire n'aide que si
// PLUSIEURS appels Google Ads ont lieu dans la même invocation (ce qui est
// le cas ici : créer un compte puis plusieurs mutate à la suite), pas d'une
// invocation à l'autre.
let accessTokenCache = null;
async function obtenirAccessToken() {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 30_000) {
    return accessTokenCache.token;
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    // Cause la plus probable si ça échoue un jour : le refresh token a été
    // révoqué (écran de consentement resté en mode "Testing" + jeton
    // expiré au bout de 7 jours — voir l'avertissement donné à Cyrille le
    // 10/09/2026). Il faudra alors en regénérer un via OAuth Playground.
    throw new Error('Impossible de rafraîchir le jeton OAuth Google Ads : ' + JSON.stringify(data));
  }
  accessTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

// Appel générique à l'API Google Ads REST. `loginCustomerId` est TOUJOURS
// le MCC (735-335-0497) : c'est lui qui authentifie l'appel en tant que
// gestionnaire, que l'opération porte sur le MCC lui-même
// (createCustomerClient) ou sur un compte enfant (mutate de campagne...).
async function appelGoogleAds(path, body) {
  const accessToken = await obtenirAccessToken();
  const resp = await fetch(`${GOOGLE_ADS_BASE}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': idSansTirets(process.env.GOOGLE_ADS_MCC_ID),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Google Ads API "${path}" a échoué : ${JSON.stringify(data)}`);
  }
  return data;
}

// Crée un nouveau compte client Google Ads sous le MCC, dédié à un artisan
// (un compte par artisan, jamais réutilisé). Retourne l'id numérique du
// nouveau compte (sans tirets), à enregistrer dans
// skyeco_pro_vitrine_drafts.google_ads_client_account_id pour ne jamais en
// recréer un deuxième pour le même artisan.
async function creerCompteClient({ nomCompte }) {
  const mccId = idSansTirets(process.env.GOOGLE_ADS_MCC_ID);
  const data = await appelGoogleAds(`customers/${mccId}:createCustomerClient`, {
    customerClient: {
      descriptiveName: String(nomCompte || 'Skyeco Pro').substring(0, 255),
      currencyCode: 'EUR',
      timeZone: 'Europe/Paris',
    },
  });
  // Réponse attendue : { resourceName: "customers/1234567890" }.
  const m = String(data.resourceName || '').match(/customers\/(\d+)/);
  if (!m) {
    throw new Error('Compte créé mais id introuvable dans la réponse Google Ads : ' + JSON.stringify(data));
  }
  return m[1];
}

// Applique une liste d'opérations "mutate" sur un service donné (campaigns,
// campaignBudgets, adGroups, adGroupCriteria, adGroupAds,
// campaignCriteria...), pour le compte client d'UN artisan (jamais le MCC).
// Retourne le tableau "results" tel que renvoyé par l'API (chaque élément a
// au moins un resourceName).
async function mutate(customerId, service, operations) {
  const data = await appelGoogleAds(`customers/${idSansTirets(customerId)}/${service}:mutate`, { operations });
  return data.results || [];
}

export { obtenirAccessToken, appelGoogleAds, creerCompteClient, mutate, idSansTirets, API_VERSION };
