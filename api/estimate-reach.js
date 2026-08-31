// /api/estimate-reach.js
// Calcule une estimation de clics/mois RÉELLE via le Keyword Planner Google
// Ads — volume de recherche et CPC — mais désormais via Windsor.ai plutôt
// que l'API Google Ads directe.
//
// Pourquoi ce changement (31/08) : l'appel direct à l'API Google Ads
// (generateKeywordIdeas) échouait avec "The caller does not have
// permission", causé par GOOGLE_ADS_LOGIN_CUSTOMER_ID pointant vers un
// compte Manager (MCC) suspendu (735-335-0497, compte personnel de Cyrille,
// sans rapport avec Skyeco Pro) — un Manager suspendu bloque TOUT appel API
// fait à travers lui, quel que soit le compte enfant interrogé. Vérifié :
// Windsor.ai a sa PROPRE connexion OAuth au compte Google Ads 784-990-3984
// (ECOSKY by RMS), totalement indépendante de ce Manager suspendu — un test
// en direct le 31/08 (via le connecteur google_ads de Windsor.ai) a bien
// renvoyé les vraies données Keyword Planner (volumes, CPC) pour ce compte.
// C'est exactement le même chemin Windsor.ai que create-google-ads-campaign.js
// utilise déjà pour créer les campagnes réelles.
//
// Nouveau côté ciblage géographique : avant, la "zone" saisie par l'artisan
// était toujours du texte libre (ex: "Brech, Bretagne"), jamais un vrai
// ciblage Google Ads — le volume était mesuré au niveau France puis réduit
// approximativement par la part de population de la région déduite du
// texte. Depuis le 31/08, skyeco-pro-formulaire-creation.html enregistre
// aussi le VRAI code département (déduit du SIRET) dans la colonne
// `departement` de skyeco_pro_vitrine_drafts. Quand ce département a un
// identifiant de géo-ciblage Google Ads vérifié dans GEO_TARGET_BY_DEPARTEMENT
// ci-dessous, on interroge le Keyword Planner DIRECTEMENT sur cette zone
// précise (volume réel local, pas une approximation) — sinon on retombe sur
// l'ancienne approximation par population.
//
// Variables d'environnement requises : WINDSOR_API_KEY, GOOGLE_ADS_ACCOUNT_ID
// (mêmes que create-google-ads-campaign.js — voir son commentaire d'en-tête
// pour la confirmation du bon compte, 7849903984, sans tirets).

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';

const KEYWORDS_BY_METIER = {
  paysagiste: ['paysagiste prix', 'aménagement extérieur paysagiste', 'devis paysagiste'],
  piscine: ['pose piscine prix', 'installation piscine devis', 'plage piscine prix'],
  tonte: ['tonte pelouse prix', 'entretien jardin prix', 'tonte gazon devis'],
  terrasse: ['terrasse bois prix', 'terrasse composite prix', 'pose terrasse devis'],
  paysagiste_concepteur: ['paysagiste concepteur prix', 'conception jardin paysagiste', 'plan aménagement extérieur'],
  arboriste: ['élagage prix', 'abattage arbre prix', 'arboriste élagueur devis'],
  espaces_verts: ['entretien espaces verts prix', 'entretien jardin copropriété', 'entreprise espaces verts devis'],
  autre: ['devis travaux extérieur', 'artisan paysagiste devis'] // repli de sécurité, non sélectionnable dans le formulaire
};

// Ciblage géographique précis par département — MÊMES identifiants que
// create-google-ads-campaign.js (à tenir synchronisé si l'un des deux fichiers
// change). IMPORTANT : un identifiant de géo-ciblage Google Ads doit être
// VÉRIFIÉ avant d'être ajouté ici (recherche du lieu dans l'outil de ciblage
// géographique de Google Ads, ou GeoTargetConstantService une fois le nouveau
// compte Manager en place) — ne jamais deviner un identifiant à partir d'une
// source tierce non confirmée, une erreur ici cible silencieusement la
// mauvaise zone.
const GEO_TARGET_BY_DEPARTEMENT = {
  '56': '1006094', // Morbihan
  '35': '1006083', // Ille-et-Vilaine
  '29': '1006082', // Finistère
  '22': '1006081', // Côtes-d'Armor
  '44': '1006095', // Loire-Atlantique
  // TODO: compléter avec les autres départements au besoin, un par un, vérifié.
};

// Correspondance officielle département → région (découpage administratif
// fixe depuis 2016, fiable à 100% — contrairement à la pondération par
// population ci-dessous, qui reste une approximation, utilisée seulement en
// repli quand le département n'est pas dans GEO_TARGET_BY_DEPARTEMENT).
const DEPARTEMENT_TO_REGION = {
  '01':'Auvergne-Rhône-Alpes','02':'Hauts-de-France','03':'Auvergne-Rhône-Alpes',
  '04':"Provence-Alpes-Côte d'Azur",'05':"Provence-Alpes-Côte d'Azur",'06':"Provence-Alpes-Côte d'Azur",
  '07':'Auvergne-Rhône-Alpes','08':'Grand Est','09':'Occitanie','10':'Grand Est','11':'Occitanie',
  '12':'Occitanie','13':"Provence-Alpes-Côte d'Azur",'14':'Normandie','15':'Auvergne-Rhône-Alpes',
  '16':'Nouvelle-Aquitaine','17':'Nouvelle-Aquitaine','18':'Centre-Val de Loire','19':'Nouvelle-Aquitaine',
  '2A':'Corse','2B':'Corse','21':'Bourgogne-Franche-Comté','22':'Bretagne','23':'Nouvelle-Aquitaine',
  '24':'Nouvelle-Aquitaine','25':'Bourgogne-Franche-Comté','26':'Auvergne-Rhône-Alpes','27':'Normandie',
  '28':'Centre-Val de Loire','29':'Bretagne','30':'Occitanie','31':'Occitanie','32':'Occitanie',
  '33':'Nouvelle-Aquitaine','34':'Occitanie','35':'Bretagne','36':'Centre-Val de Loire','37':'Centre-Val de Loire',
  '38':'Auvergne-Rhône-Alpes','39':'Bourgogne-Franche-Comté','40':'Nouvelle-Aquitaine','41':'Centre-Val de Loire',
  '42':'Auvergne-Rhône-Alpes','43':'Auvergne-Rhône-Alpes','44':'Pays de la Loire','45':'Centre-Val de Loire',
  '46':'Occitanie','47':'Nouvelle-Aquitaine','48':'Occitanie','49':'Pays de la Loire','50':'Normandie',
  '51':'Grand Est','52':'Grand Est','53':'Pays de la Loire','54':'Grand Est','55':'Grand Est',
  '56':'Bretagne','57':'Grand Est','58':'Bourgogne-Franche-Comté','59':'Hauts-de-France','60':'Hauts-de-France',
  '61':'Normandie','62':'Hauts-de-France','63':'Auvergne-Rhône-Alpes','64':'Nouvelle-Aquitaine',
  '65':'Occitanie','66':'Occitanie','67':'Grand Est','68':'Grand Est','69':'Auvergne-Rhône-Alpes',
  '70':'Bourgogne-Franche-Comté','71':'Bourgogne-Franche-Comté','72':'Pays de la Loire','73':'Auvergne-Rhône-Alpes',
  '74':'Auvergne-Rhône-Alpes','75':'Île-de-France','76':'Normandie','77':'Île-de-France','78':'Île-de-France',
  '79':'Nouvelle-Aquitaine','80':'Hauts-de-France','81':'Occitanie','82':'Occitanie',
  '83':"Provence-Alpes-Côte d'Azur",'84':"Provence-Alpes-Côte d'Azur",'85':'Pays de la Loire',
  '86':'Nouvelle-Aquitaine','87':'Nouvelle-Aquitaine','88':'Grand Est','89':'Bourgogne-Franche-Comté',
  '90':'Bourgogne-Franche-Comté','91':'Île-de-France','92':'Île-de-France','93':'Île-de-France',
  '94':'Île-de-France','95':'Île-de-France',
  '971':'Guadeloupe','972':'Martinique','973':'Guyane','974':'La Réunion','976':'Mayotte'
};

// Part approximative de la population française par région (INSEE, arrondie).
// Utilisée uniquement en repli, quand le département n'a pas de ciblage
// géographique précis disponible dans GEO_TARGET_BY_DEPARTEMENT.
const REGION_POPULATION_SHARE = {
  'Île-de-France': 0.182, 'Auvergne-Rhône-Alpes': 0.121, 'Hauts-de-France': 0.089,
  'Nouvelle-Aquitaine': 0.092, 'Occitanie': 0.088, 'Grand Est': 0.083,
  "Provence-Alpes-Côte d'Azur": 0.077, 'Pays de la Loire': 0.059, 'Normandie': 0.050,
  'Bretagne': 0.051, 'Bourgogne-Franche-Comté': 0.042, 'Centre-Val de Loire': 0.039,
  'Corse': 0.005, 'Guadeloupe': 0.006, 'Martinique': 0.005, 'Guyane': 0.004,
  'La Réunion': 0.013, 'Mayotte': 0.004
};

// France entière (niveau pays), utilisé comme cible de requête quand aucun
// département précis n'est configuré — le volume est ensuite réduit
// proportionnellement à la population de la région déduite du département.
const GEO_TARGET_FRANCE = '2250';

// Interroge le Keyword Planner Google Ads via Windsor.ai (mêmes identifiants
// de champs que ceux découverts et testés le 31/08 : keyword,
// avg_monthly_searches, keyword_competition, competition_index,
// keyword_average_cpc — la description Windsor de "keyword" est explicite :
// "The keyword idea text returned by Keyword Planner").
async function interrogerWindsorKeywordPlanner({ keywords, geoTargetConstantId }) {
  // Format du compte : testé et confirmé le 31/08 via l'outil MCP Windsor.ai
  // (get_data) avec le tiret inclus ("784-990-3984"), pas la forme sans
  // tiret utilisée ailleurs (create-google-ads-campaign.js, endpoint
  // /actions — un format différent pour un endpoint différent).
  const chiffres = (process.env.GOOGLE_ADS_ACCOUNT_ID || '').replace(/[^0-9]/g, '');
  const accountId = chiffres.length === 10
    ? `${chiffres.slice(0, 3)}-${chiffres.slice(3, 6)}-${chiffres.slice(6)}`
    : chiffres;

  // Format confirmé par le support Windsor.ai le 31/08 (réf. ticket 81695202,
  // après plusieurs essais infructueux) : le sélecteur de compte est
  // "select_accounts" (pas "accounts" ni "google_ads_accounts"), et les
  // options spécifiques Keyword Planner doivent être imbriquées dans un
  // objet JSON sous la clé du connecteur ("google_ads"), pas au premier
  // niveau — {"google_ads": {"keyword_seeds": ..., ...}}, jamais
  // {"keyword_seeds": ...} directement.
  const options = JSON.stringify({
    google_ads: {
      keyword_seeds: keywords.join(','),
      geo_target_constants: geoTargetConstantId,
      language: '1002', // français
      keyword_plan_network: 'GOOGLE_SEARCH',
    },
  });

  const params = new URLSearchParams({
    api_key: process.env.WINDSOR_API_KEY,
    select_accounts: accountId,
    date_preset: 'last_30d',
    fields: 'keyword,avg_monthly_searches,keyword_competition,competition_index,keyword_average_cpc',
    options,
  });

  const resp = await fetch(`${WINDSOR_BASE}?${params.toString()}`);
  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error('Réponse Windsor.ai illisible (pas du JSON) : ' + raw.slice(0, 300));
  }
  if (!resp.ok) {
    throw new Error('Windsor.ai Keyword Planner erreur : ' + JSON.stringify(data));
  }
  // Windsor.ai renvoie en général { data: [...] } — mais on reste tolérant à
  // d'autres formes (tableau direct, ou clé "result") pour ne pas casser
  // silencieusement si le format exact diffère de ce qui a été testé via MCP.
  const rows = Array.isArray(data) ? data : (data.data || data.result || []);
  if (!Array.isArray(rows)) {
    throw new Error('Format de réponse Windsor.ai inattendu : ' + JSON.stringify(data).slice(0, 300));
  }
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { metier, zone, motsCles, budget, departement } = req.body || {};
  // "metier" peut être un tableau (nouvelle sélection multiple) ou une chaîne
  // unique (anciens sites créés avant ce changement) — on gère les deux.
  const metiersListe = Array.isArray(metier) ? metier : (metier ? [metier] : []);

  // Priorité aux mots-clés choisis par l'artisan (checkboxes IA dans
  // mon-dashboard.html, colonne mots_cles_choisis) — même logique de repli
  // que create-google-ads-campaign.js : sinon on retombe sur la liste fixe
  // par métier.
  const motsClesChoisis = Array.isArray(motsCles)
    ? motsCles.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim().substring(0, 80)).slice(0, 25)
    : [];
  const keywords = motsClesChoisis.length
    ? [...new Set(motsClesChoisis)]
    : (metiersListe.length
        ? [...new Set(metiersListe.flatMap(m => KEYWORDS_BY_METIER[m] || []))]
        : KEYWORDS_BY_METIER.autre);
  const budgetNum = parseFloat(budget);

  // Formule "abonnement" : facturé séparément, hors de ce calcul — commission
  // prélevée sur le budget publicitaire alloué par le client. Le reste part
  // réellement en dépense pub sur Google Ads.
  const TAUX_COMMISSION = 0.50; // 50% pour l'instant
  const commissionPub = budgetNum ? +(budgetNum * TAUX_COMMISSION).toFixed(2) : 0;
  const budgetNetPub = Math.max(0, budgetNum - commissionPub);

  // Ciblage géographique : département précis si on l'a et qu'il est
  // configuré dans GEO_TARGET_BY_DEPARTEMENT (volume RÉEL pour cette zone,
  // pas d'approximation) — sinon repli sur le comportement précédent
  // (France entière, pondérée par la population de la région déduite du
  // texte libre "zone").
  const departementCode = departement ? String(departement).trim().toUpperCase() : null;
  const geoTargetPrecis = departementCode ? GEO_TARGET_BY_DEPARTEMENT[departementCode] : null;
  const geoTargetConstantId = geoTargetPrecis || GEO_TARGET_FRANCE;
  const geoApprox = !geoTargetPrecis;
  const regionDeduite = departementCode && DEPARTEMENT_TO_REGION[departementCode]
    ? DEPARTEMENT_TO_REGION[departementCode]
    : (zone && zone.includes(',') ? zone.split(',').pop().trim() : null);
  const populationShare = geoApprox && regionDeduite ? REGION_POPULATION_SHARE[regionDeduite] : null;

  try {
    const idees = await interrogerWindsorKeywordPlanner({ keywords, geoTargetConstantId });

    const construireMotCle = (idee) => ({
      keyword: idee.keyword,
      monthly_volume: parseInt(idee.avg_monthly_searches || 0, 10),
      cpc_eur: +((parseFloat(idee.keyword_average_cpc || 0)) / 1_000_000).toFixed(2),
      competition: idee.keyword_competition || 'UNKNOWN',
    });

    // On ne garde que les idées qui correspondent réellement à nos mots-clés
    // de départ (Windsor peut aussi renvoyer des suggestions élargies).
    const motsCles = idees
      .filter((idee) => idee.keyword && keywords.some((k) => idee.keyword.toLowerCase().includes(k.split(' ')[0].toLowerCase())))
      .map(construireMotCle);

    // Si le filtre n'a rien gardé, on retombe sur toutes les idées reçues
    // plutôt que de renvoyer un tableau vide.
    const motsClesFinal = motsCles.length > 0 ? motsCles : idees.slice(0, keywords.length).map(construireMotCle);

    const totalMonthlyVolumeBrut = motsClesFinal.reduce((sum, k) => sum + (k.monthly_volume || 0), 0);

    // Si on n'a pas de ciblage département précis, on réduit le volume
    // (mesuré au niveau France) proportionnellement à la population de la
    // région déduite — mieux qu'afficher tel quel un volume national.
    const totalMonthlyVolume = populationShare
      ? Math.max(1, Math.round(totalMonthlyVolumeBrut * populationShare))
      : totalMonthlyVolumeBrut;

    const cpcValides = motsClesFinal.map((k) => k.cpc_eur).filter((v) => v > 0);
    const avgCpcEur = cpcValides.length
      ? +(cpcValides.reduce((a, b) => a + b, 0) / cpcValides.length).toFixed(2)
      : null;

    let estimatedClicks = null;
    if (avgCpcEur && budgetNetPub > 0) {
      const clicksFromBudget = Math.round(budgetNetPub / avgCpcEur);
      estimatedClicks = totalMonthlyVolume
        ? Math.min(clicksFromBudget, totalMonthlyVolume)
        : clicksFromBudget;
    }

    return res.status(200).json({
      success: true,
      source: 'windsor_ai_keyword_planner',
      motsClesPersonnalises: motsClesChoisis.length > 0, // true = basé sur les mots-clés choisis par l'artisan, false = liste générique par métier
      zone: zone || null,
      departement: departementCode,
      region: regionDeduite,
      geoApproximatif: geoApprox, // true = volume France pondéré par population (pas de département précis disponible) ; false = volume réel mesuré directement sur le département ciblé
      populationShare,
      keywords: motsClesFinal,
      totalMonthlyVolumeNational: geoApprox ? totalMonthlyVolumeBrut : null,
      totalMonthlyVolume,
      avgCpcEur,
      budgetPaye: budgetNum || null,
      tauxCommission: TAUX_COMMISSION,
      commissionPub: budgetNum ? commissionPub : null,
      budgetNetPub: budgetNum ? budgetNetPub : null,
      estimatedClicks,
    });
  } catch (err) {
    console.error('Erreur estimation Keyword Planner (Windsor.ai) :', err);
    return res.status(500).json({ success: false, error: "Impossible de calculer l'estimation pour le moment : " + err.message });
  }
}
