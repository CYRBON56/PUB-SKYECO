// /api/_lib/campagne-nationale.js
// Constantes et helpers partagés pour le dashboard ADMIN de la campagne
// Google Ads NATIONALE (recrutement d'artisans BTP pour Skyeco Ads),
// distincte des campagnes par-artisan gérées ailleurs dans ce projet
// (get-google-ads-details.js, pause-campagne-ads.js, get-campaign-spend.js).
// Source de vérité pour tous les IDs ci-dessous : le document de suivi
// "skyeco-pro-brief-google-ads-national-saas.md", sections 7 (création),
// 8 et 9 (les 2 changements de destination du 17/09/2026 au soir).
//
// Compte Google Ads utilisé : 784-990-3984 ("ECOSKY by RMS") — décision
// finale de Cyrille (section 7 du brief) : pas de nouveau compte dédié,
// pour éviter tout délai de vérification/moyen de paiement sur un compte
// neuf. Ce compte fait AUSSI tourner la campagne résine/Morbihan de
// Cyrille et les campagnes par-artisan : chaque campagne a son propre
// budget et ses propres mots-clés, elles ne se marchent pas dessus, mais
// ce fichier ne doit jamais toucher un campaign_id/ad_group_id qui n'est
// pas listé ici.
//
// Particularité connue de Windsor.ai (déjà documentée dans
// skyeco-pro-etat-technique.md, et reconfirmée en direct le 17/09 avant
// d'écrire ce fichier) : ses rapports de lecture (get_data / l'endpoint
// REST /google_ads) sont des rapports de PERFORMANCE, joints à des
// statistiques Google Ads — une campagne qui n'a encore reçu AUCUNE
// impression n'apparaît dans AUCUN rapport basé sur les entités
// campagne/groupe/annonce/mot-clé, même en interrogeant sur last_year
// sans filtre. Cette campagne a été créée en pause le 17/09 et n'a (à la
// date de ce fichier) jamais servi une seule impression : il est donc
// NORMAL que les lectures ci-dessous renvoient des tableaux vides tant que
// Cyrille ne l'a pas activée. Seuls les champs de BUDGET (budget_amount,
// campaign_budget_status) ont un rapport séparé qui, lui, fonctionne même
// à zéro impression (vérifié en direct). Ce n'est pas une panne : le
// dashboard doit l'afficher comme un état normal ("pas encore de
// données"), jamais comme une erreur.

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';

export const GOOGLE_ADS_ACCOUNT_ID = '784-990-3984';

export const CAMPAGNE = {
  id: '24267076996',
  nom: 'Skyeco Pro — Acquisition nationale artisans BTP',
  type: 'Recherche (Search)',
  geo: 'France entière (2250) + français',
  enchere: 'CPC manuel',
  budgetQuotidienEurosCreation: 20,
};

// Les 3 groupes d'annonces créés le 17/09/2026. `adActuel` est l'annonce EN
// COURS (celle qui pointe vers la destination retenue en section 9 du
// brief : skyeco-pro-formulaire-creation.html). `anciennesAnnonces` liste
// les annonces des 2 destinations abandonnées dans la même journée (page
// dédiée pub, puis skyeco.fr) : elles restent visibles, en pause, dans
// l'historique de chaque groupe (Windsor.ai n'a pas d'action de
// suppression d'annonce) mais ne doivent normalement plus être touchées —
// gardées ici uniquement pour référence/traçabilité dans le dashboard.
export const GROUPES_ANNONCES = [
  {
    id: '200459739339',
    nom: 'Logiciel devis & gestion BTP',
    motsCles: [
      'logiciel devis btp',
      'logiciel devis artisan',
      'logiciel devis en ligne artisan',
      'devis avec signature électronique btp',
      'créer un devis en ligne artisan',
    ],
    adActuel: {
      adId: '825035540572',
      urlFinale: 'https://pub-skyeco-23ue.vercel.app/skyeco-pro-formulaire-creation.html',
    },
    anciennesAnnonces: [
      { adId: '824993580879', urlFinale: 'skyeco-ads-landing-nationale.html (abandonnée)' },
      { adId: '825035151055', urlFinale: 'skyeco.fr (abandonnée)' },
    ],
  },
  {
    id: '208714807348',
    nom: 'Génération de prospects BTP',
    motsCles: [
      'générer des prospects qualifiés artisan',
      'trouver des clients artisan btp',
      'alternative achat de leads btp',
      'acheter des leads btp',
    ],
    adActuel: {
      adId: '825035542456',
      urlFinale: 'https://pub-skyeco-23ue.vercel.app/skyeco-pro-formulaire-creation.html',
    },
    anciennesAnnonces: [
      { adId: '825033983698', urlFinale: 'skyeco-ads-landing-nationale.html (abandonnée)' },
      { adId: '824994923508', urlFinale: 'skyeco.fr (abandonnée)' },
    ],
  },
  {
    id: '200338292156',
    nom: 'Google Ads pour artisan',
    motsCles: [
      'publicité google ads pour artisan',
      'agence google ads btp',
      'gérer ses google ads soi-même artisan',
      'campagne google ads artisan btp',
    ],
    adActuel: {
      adId: '825121013708',
      urlFinale: 'https://pub-skyeco-23ue.vercel.app/skyeco-pro-formulaire-creation.html',
    },
    anciennesAnnonces: [
      { adId: '825033965752', urlFinale: 'skyeco-ads-landing-nationale.html (abandonnée)' },
      { adId: '825120589574', urlFinale: 'skyeco.fr (abandonnée)' },
    ],
  },
];

export function trouverGroupe(adGroupId) {
  return GROUPES_ANNONCES.find((g) => g.id === String(adGroupId));
}

// Écriture : passe par /google_ads/actions, exactement comme
// pause-campagne-ads.js. Le compte doit être envoyé AVEC tirets
// ("784-990-3984") — bug déjà rencontré et corrigé sur ce projet le 03/09
// quand il était envoyé sans tirets.
export async function executerAction(action, params) {
  const resp = await fetch(`${WINDSOR_BASE}/actions?api_key=${process.env.WINDSOR_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: GOOGLE_ADS_ACCOUNT_ID, action, params }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Action Windsor.ai "${action}" échouée : ${JSON.stringify(data)}`);
  return data;
}

// Lecture : même construction d'URL que get-google-ads-details.js
// (filtre campaign_id eq, date_preset, data.data). Enveloppée en "best
// effort" ({ok, lignes, erreur?}) plutôt que de laisser l'erreur remonter :
// une lecture vide ou en échec ne doit jamais empêcher le reste du
// dashboard de s'afficher (voir le commentaire en tête de fichier sur le
// cas normal "campagne jamais servie").
//
// IMPORTANT (bug corrigé le 17/09/2026 soir) : cette fonction n'envoyait
// jusqu'ici AUCUN paramètre de compte à Windsor.ai, en comptant sur le fait
// que le filtre campaign_id suffirait à isoler la bonne campagne. Vérifié en
// direct : pour certains rapports (notamment le contenu réel des annonces —
// titres/descriptions), Windsor.ai renvoie un tableau VIDE sans le paramètre
// `accounts` explicite, même quand la campagne a des données, alors que le
// même appel avec `accounts=784-990-3984` renvoie bien les lignes attendues.
// Le paramètre est donc désormais toujours envoyé, ce qui n'a pas changé le
// résultat des rapports qui fonctionnaient déjà (budget, mots-clés) mais a
// débloqué celui du contenu des annonces.
export async function interrogerWindsor(fields, datePreset = 'last_90d') {
  try {
    const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', CAMPAGNE.id]]));
    const champs = Array.isArray(fields) ? fields.join(',') : fields;
    const url = `${WINDSOR_BASE}?api_key=${process.env.WINDSOR_API_KEY}&accounts=${encodeURIComponent(GOOGLE_ADS_ACCOUNT_ID)}&fields=${champs}&filter=${filtre}&date_preset=${datePreset}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) return { ok: false, lignes: [], erreur: data?.message || JSON.stringify(data) };
    return { ok: true, lignes: Array.isArray(data.data) ? data.data : [] };
  } catch (e) {
    return { ok: false, lignes: [], erreur: e.message };
  }
}

export function eurosVersMicros(euros) {
  return Math.round(Number(euros) * 1_000_000);
}
