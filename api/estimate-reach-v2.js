// /api/estimate-reach.js
// Calcule une estimation de clics/mois RÉELLE via le Keyword Planner de
// l'API Google Ads (GenerateKeywordIdeas) — volume de recherche et CPC
// directement issus de Google, avec un vrai ciblage géographique par
// département (contrairement à l'ancienne version basée sur OpenRush, qui
// ne connaissait que le niveau pays et approximait via la population).
//
// Variables d'environnement requises :
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID

const GOOGLE_ADS_API_VERSION = 'v18';
const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

const KEYWORDS_BY_METIER = {
  resine: ['terrasse résine prix', 'revêtement résine extérieur prix', 'sol résine terrasse'],
  cloture: ['clôture jardin prix', 'pose clôture prix', 'portail motorisé prix'],
  terrassement: ['terrassement prix m2', 'entreprise terrassement devis', 'nivellement terrain prix'],
  assainissement: ['assainissement non collectif prix', 'installation fosse septique prix', 'micro station épuration prix'],
  paysagisme: ['paysagiste prix', 'entretien jardin prix', 'aménagement extérieur paysagiste'],
  autre: ['devis travaux extérieur', 'artisan btp devis']
};

// Mêmes codes de ciblage géographique que create-google-ads-campaign.js —
// à tenir synchronisé, ou factoriser dans un fichier partagé si la liste grandit.
const GEO_TARGET_BY_DEPARTEMENT = {
  '56': '1006094', // Morbihan
  '35': '1006083', // Ille-et-Vilaine
  '29': '1006082', // Finistère
  '22': '1006081', // Côtes-d'Armor
  '44': '1006095', // Loire-Atlantique
  // TODO: compléter avec les autres départements au besoin
};

// Correspondance officielle département → région (découpage administratif
// fixe depuis 2016, fiable à 100% — contrairement à la pondération par
// population ci-dessous, qui reste une approximation).
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

async function obtenirAccessToken() {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error('Échec obtention access token Google : ' + detail);
  }
  const data = await resp.json();
  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { metier, departement, budget } = req.body || {};
  const keywords = KEYWORDS_BY_METIER[metier] || KEYWORDS_BY_METIER.autre;
  const budgetNum = parseFloat(budget);

  // Formule "abonnement" : 39,90€/mois (facturé séparément, hors de ce calcul)
  // + commission de 20% prélevée sur le budget publicitaire alloué par le
  // client. Le reste (80%) part réellement en dépense pub sur Google Ads.
  const TAUX_COMMISSION = 0.50; // 50% pour l'instant
  const commissionPub = budgetNum ? +(budgetNum * TAUX_COMMISSION).toFixed(2) : 0;
  const budgetNetPub = Math.max(0, budgetNum - commissionPub);

  const geoTargetId = (departement && GEO_TARGET_BY_DEPARTEMENT[departement]) || null;
  const geoResourceName = geoTargetId
    ? `geoTargetConstants/${geoTargetId}`
    : `geoTargetConstants/${GEO_TARGET_FRANCE}`;
  const geoApprox = !geoTargetId; // true si on interroge la France entière puis on pondère
  const regionDeduite = departement ? DEPARTEMENT_TO_REGION[String(departement).toUpperCase()] : null;
  const populationShare = geoApprox && regionDeduite ? REGION_POPULATION_SHARE[regionDeduite] : null;

  try {
    const accessToken = await obtenirAccessToken();
    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;

    const resp = await fetch(
      `${GOOGLE_ADS_BASE_URL}/customers/${customerId}:generateKeywordIdeas`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          geoTargetConstants: [geoResourceName],
          language: 'languageConstants/1002', // Français
          keywordSeed: { keywords },
          keywordPlanNetwork: 'GOOGLE_SEARCH',
        }),
      }
    );

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Google Ads Keyword Planner erreur :', JSON.stringify(data));
      throw new Error(data.error?.message || 'Échec Keyword Planner');
    }

    const idees = data.results || [];

    // On ne garde que les idées qui correspondent réellement à nos mots-clés
    // de départ (l'API renvoie aussi des suggestions élargies qu'on ignore ici).
    const motsCles = idees
      .filter((idee) => keywords.some((k) => idee.text?.toLowerCase().includes(k.split(' ')[0].toLowerCase())))
      .map((idee) => {
        const m = idee.keywordIdeaMetrics || {};
        const lowMicros = parseInt(m.lowTopOfPageBidMicros || '0', 10);
        const highMicros = parseInt(m.highTopOfPageBidMicros || '0', 10);
        const cpcMoyenMicros = lowMicros && highMicros ? (lowMicros + highMicros) / 2 : (lowMicros || highMicros || 0);
        return {
          keyword: idee.text,
          monthly_volume: parseInt(m.avgMonthlySearches || '0', 10),
          cpc_eur: +(cpcMoyenMicros / 1_000_000).toFixed(2),
          competition: m.competition || 'UNKNOWN',
        };
      });

    // Si le filtre n'a rien gardé (l'API a renvoyé des variantes trop éloignées),
    // on retombe sur toutes les idées reçues plutôt que de renvoyer un tableau vide.
    const motsClesFinal = motsCles.length > 0 ? motsCles : idees.slice(0, keywords.length).map((idee) => {
      const m = idee.keywordIdeaMetrics || {};
      const lowMicros = parseInt(m.lowTopOfPageBidMicros || '0', 10);
      const highMicros = parseInt(m.highTopOfPageBidMicros || '0', 10);
      const cpcMoyenMicros = lowMicros && highMicros ? (lowMicros + highMicros) / 2 : (lowMicros || highMicros || 0);
      return {
        keyword: idee.text,
        monthly_volume: parseInt(m.avgMonthlySearches || '0', 10),
        cpc_eur: +(cpcMoyenMicros / 1_000_000).toFixed(2),
        competition: m.competition || 'UNKNOWN',
      };
    });

    const totalMonthlyVolumeBrut = motsClesFinal.reduce((sum, k) => sum + k.monthly_volume, 0);

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
      source: 'google_ads_keyword_planner',
      departement: departement || null,
      region: regionDeduite,
      geoApproximatif: geoApprox, // true = volume France pondéré par population, pas un ciblage département natif
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
    console.error('Erreur estimation Keyword Planner :', err);
    return res.status(500).json({ success: false, error: "Impossible de calculer l'estimation pour le moment : " + err.message });
  }
}
