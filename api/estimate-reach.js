// /api/estimate-reach.js
// Calcule une estimation de clics/mois réaliste à partir de vraies données de recherche (OpenRush).
// Le volume n'est disponible qu'à l'échelle nationale (limite de la base OpenRush/DataForSEO pour la France) —
// on le pondère par la part de population de la région choisie, à titre d'approximation, pas une vraie donnée régionale.
// Variable d'environnement requise : OPENRUSH_API_KEY

const KEYWORDS_BY_METIER = {
  resine: ['terrasse résine prix', 'revêtement résine extérieur prix', 'sol résine terrasse'],
  cloture: ['clôture jardin prix', 'pose clôture prix', 'portail motorisé prix'],
  terrassement: ['terrassement prix m2', 'entreprise terrassement devis', 'nivellement terrain prix'],
  assainissement: ['assainissement non collectif prix', 'installation fosse septique prix', 'micro station épuration prix'],
  paysagisme: ['paysagiste prix', 'entretien jardin prix', 'aménagement extérieur paysagiste'],
  autre: ['devis travaux extérieur', 'artisan btp devis']
};

// Part approximative de la population française par région (INSEE, arrondie).
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

  const { metier, zone, budget } = req.body || {};
  const keywords = KEYWORDS_BY_METIER[metier] || KEYWORDS_BY_METIER.autre;
  const location = 'France'; // OpenRush n'accepte que des pays comme zone géographique, pas des régions
  const budgetNum = parseFloat(budget);
  const populationShare = REGION_POPULATION_SHARE[zone] || null;

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
      zone: zone || null,
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
