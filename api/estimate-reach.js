// /api/estimate-reach.js
// Calcule une estimation de clics/mois réaliste à partir de vraies données de recherche (OpenRush).
// Variable d'environnement requise : OPENRUSH_API_KEY

// Mots-clés représentatifs par métier — liste fixe, pas de saisie libre.
const KEYWORDS_BY_METIER = {
  resine: ['terrasse résine prix', 'revêtement résine extérieur prix', 'sol résine terrasse'],
  cloture: ['clôture jardin prix', 'pose clôture prix', 'portail motorisé prix'],
  terrassement: ['terrassement prix m2', 'entreprise terrassement devis', 'nivellement terrain prix'],
  assainissement: ['assainissement non collectif prix', 'installation fosse septique prix', 'micro station épuration prix'],
  paysagisme: ['paysagiste prix', 'entretien jardin prix', 'aménagement extérieur paysagiste'],
  autre: ['devis travaux extérieur', 'artisan btp devis']
};

const USD_TO_EUR = 0.92; // conversion approximative

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { metier, zone, budget } = req.body || {};
  const keywords = KEYWORDS_BY_METIER[metier] || KEYWORDS_BY_METIER.autre;
  const location = (zone && zone.trim()) ? zone.trim() : 'France';
  const budgetNum = parseFloat(budget);

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

    const totalVolume = results.reduce((sum, r) => sum + (r.monthly_volume || 0), 0);
    const cpcs = results.map(r => r.cpc_usd).filter(v => typeof v === 'number' && v > 0);
    const avgCpcUsd = cpcs.length ? cpcs.reduce((a, b) => a + b, 0) / cpcs.length : null;
    const avgCpcEur = avgCpcUsd ? +(avgCpcUsd * USD_TO_EUR).toFixed(2) : null;

    let estimatedClicks = null;
    if (avgCpcEur && budgetNum > 0) {
      estimatedClicks = Math.round(budgetNum / avgCpcEur);
    }

    return res.status(200).json({
      success: true,
      location,
      keywords: results.map(r => ({ keyword: r.keyword, monthly_volume: r.monthly_volume, cpc_usd: r.cpc_usd })),
      totalMonthlyVolume: totalVolume,
      avgCpcEur,
      estimatedClicks
    });
  } catch (err) {
    console.error('Erreur estimation OpenRush :', err);
    return res.status(500).json({ success: false, error: "Impossible de calculer l'estimation pour le moment." });
  }
}
