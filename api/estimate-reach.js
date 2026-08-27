// /api/estimate-reach.js
// Calcule une estimation de clics/mois réaliste à partir de vraies données de recherche (OpenRush).
// Le volume n'est disponible qu'à l'échelle nationale (limite de la base OpenRush/DataForSEO pour la France) —
// on le pondère par la part de population de la région, à titre d'approximation, pas une vraie donnée régionale.
// Variable d'environnement requise : OPENRUSH_API_KEY

const KEYWORDS_BY_METIER = {
  resine: ['terrasse résine prix', 'revêtement résine extérieur prix', 'sol résine terrasse'],
  cloture: ['clôture jardin prix', 'pose clôture prix', 'portail motorisé prix'],
  terrassement: ['terrassement prix m2', 'entreprise terrassement devis', 'nivellement terrain prix'],
  assainissement: ['assainissement non collectif prix', 'installation fosse septique prix', 'micro station épuration prix'],
  paysagisme: ['paysagiste prix', 'entretien jardin prix', 'aménagement extérieur paysagiste'],
  autre: ['devis travaux extérieur', 'artisan btp devis']
};

// Correspondance officielle département → région (découpage administratif fixe
// depuis 2016, aucune approximation ici — contrairement à la pondération par
// population qui reste une estimation).
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
// Cette partie RESTE une estimation — seule la correspondance département→région ci-dessus est exacte.
const REGION_POPULATION_SHARE = {
  'Île-de-France': 0.182,
  'Auvergne-Rhône-Alpes': 0.121,
  'Hauts-de-France': 0.089,
  'Nouvelle-Aquitaine': 0.092,
  'Occitanie': 0.088,
  'Grand Est': 0.083,
  "Provence-Alpes-Côte d'Azur": 0.077,
  'Pays de la Loire': 0.059,
  'Normandie': 0.050,
  'Bretagne': 0.051,
  'Bourgogne-Franche-Comté': 0.042,
  'Centre-Val de Loire': 0.039,
  'Corse': 0.005,
  'Guadeloupe': 0.006,
  'Martinique': 0.005,
  'Guyane': 0.004,
  'La Réunion': 0.013,
  'Mayotte': 0.004
};

const USD_TO_EUR = 0.92; // conversion approximative

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { metier, zone, departement, budget } = req.body || {};
  const keywords = KEYWORDS_BY_METIER[metier] || KEYWORDS_BY_METIER.autre;
  const location = 'France'; // OpenRush n'accepte que des pays comme zone géographique, pas des régions
  const budgetNum = parseFloat(budget);

  // Le département (fiable, issu du SIRET) est prioritaire sur le texte libre
  // "zone" (qui peut contenir "Ville, Région" et ne matcherait plus la table).
  const regionDeduite = (departement && DEPARTEMENT_TO_REGION[String(departement).toUpperCase()])
    || zone // repli : correspond seulement si zone est un nom de région exact
    || null;
  const populationShare = REGION_POPULATION_SHARE[regionDeduite] || null;

  if (!process.env.OPENRUSH_API_KEY) {
    return res.status(500).json({ success: false, error: "Clé OpenRush non configurée." });
  }

  try {
    const results = await Promise.all(
      keywords.map(async (keyword) => {
        const resp = await fetch('https://api.openrush.com/v1/tools/inspect_keyword', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENRUSH_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ keyword, location, language: 'French' })
        });
        if (!resp.ok) throw new Error(`OpenRush a répondu ${resp.status} pour "${keyword}"`);
        const json = await resp.json();
        return json.data;
      })
    );

    const totalVolumeNational = results.reduce((sum, r) => sum + (r.monthly_volume || 0), 0);
    const cpcs = results.map(r => r.cpc_usd).filter(v => typeof v === 'number' && v > 0);
    const avgCpcUsd = cpcs.length ? cpcs.reduce((a, b) => a + b, 0) / cpcs.length : null;
    const avgCpcEur = avgCpcUsd ? +(avgCpcUsd * USD_TO_EUR).toFixed(2) : null;

    // Volume régional approximatif = volume national × part de population de la région.
    const estimatedRegionalVolume = populationShare
      ? Math.max(1, Math.round(totalVolumeNational * populationShare))
      : null;

    let estimatedClicks = null;
    if (avgCpcEur && budgetNum > 0) {
      const clicksFromBudget = Math.round(budgetNum / avgCpcEur);
      // Le budget ne peut pas capter plus de clics que ce que le marché régional permet.
      estimatedClicks = estimatedRegionalVolume
        ? Math.min(clicksFromBudget, estimatedRegionalVolume)
        : clicksFromBudget;
    }

    return res.status(200).json({
      success: true,
      location,
      departement: departement || null,
      region: regionDeduite,
      populationShare,
      keywords: results.map(r => ({ keyword: r.keyword, monthly_volume: r.monthly_volume, cpc_usd: r.cpc_usd })),
      totalMonthlyVolumeNational: totalVolumeNational,
      estimatedRegionalVolume,
      avgCpcEur,
      estimatedClicks
    });
  } catch (err) {
    console.error('Erreur estimation OpenRush :', err);
    return res.status(500).json({ success: false, error: "Impossible de calculer l'estimation pour le moment." });
  }
}
