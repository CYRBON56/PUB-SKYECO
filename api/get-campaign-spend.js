// /api/get-campaign-spend.js
// Récupère la dépense RÉELLE d'une campagne Google Ads (ce que Google a
// vraiment prélevé), puis calcule la "consommation ajustée" côté artisan :
// comme la commission de service est de 50%, chaque euro réellement dépensé
// sur Google correspond à 2€ consommés du budget qu'il a payé.
//
// Variables d'environnement requises :
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const GOOGLE_ADS_API_VERSION = 'v18';
const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

// Même taux que create-google-ads-campaign.js et estimate-reach.js —
// à tenir synchronisé si ça change à nouveau.
const TAUX_COMMISSION = 0.50;
// Facteur de conversion : 1€ dépensé chez Google = X€ consommés du budget payé.
// Avec 50% de commission, 1€ Google = 2€ de budget payé consommé.
const FACTEUR_CONSOMMATION = 1 / (1 - TAUX_COMMISSION);

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

  const { draft_id } = req.body || {};
  if (!draft_id) {
    return res.status(400).json({ success: false, error: 'draft_id manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Récupère le brouillon (budget payé + référence de la campagne).
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=tarif_prix,google_ads_campaign_resource`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }
    if (!draft.google_ads_campaign_resource) {
      return res.status(200).json({
        success: true,
        campagneExiste: false,
        message: 'Aucune campagne active pour ce site.',
      });
    }

    const budgetPaye = parseFloat(draft.tarif_prix) || 0;
    const campaignId = draft.google_ads_campaign_resource.split('/').pop();

    // 2. Interroge le coût réel du mois en cours sur Google Ads (GAQL).
    const accessToken = await obtenirAccessToken();
    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
    const query = `
      SELECT campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions
      FROM campaign
      WHERE campaign.id = ${campaignId}
        AND segments.date DURING THIS_MONTH
    `;

    const searchResp = await fetch(
      `${GOOGLE_ADS_BASE_URL}/customers/${customerId}/googleAds:search`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      }
    );
    const searchData = await searchResp.json();
    if (!searchResp.ok) {
      console.error('Erreur lecture dépense Google Ads :', JSON.stringify(searchData));
      throw new Error(searchData.error?.message || 'Échec lecture dépense');
    }

    // Additionne le coût sur toutes les lignes renvoyées (une par jour en général).
    const lignes = searchData.results || [];
    const coutReelMicros = lignes.reduce((sum, l) => sum + parseInt(l.metrics?.costMicros || '0', 10), 0);
    const clicsReels = lignes.reduce((sum, l) => sum + parseInt(l.metrics?.clicks || '0', 10), 0);
    const impressionsReelles = lignes.reduce((sum, l) => sum + parseInt(l.metrics?.impressions || '0', 10), 0);

    const coutReelEuros = +(coutReelMicros / 1_000_000).toFixed(2);
    // La consommation "affichée" à l'artisan : chaque euro réellement dépensé
    // chez Google compte double, puisque la moitié de ce qu'il a payé part en commission.
    const consommationAjustee = +(coutReelEuros * FACTEUR_CONSOMMATION).toFixed(2);
    const budgetRestant = Math.max(0, +(budgetPaye - consommationAjustee).toFixed(2));

    return res.status(200).json({
      success: true,
      campagneExiste: true,
      budgetPaye,
      coutReelGoogleEuros: coutReelEuros,
      consommationAjustee,
      budgetRestant,
      pourcentageConsomme: budgetPaye > 0 ? Math.min(100, Math.round((consommationAjustee / budgetPaye) * 100)) : 0,
      clics: clicsReels,
      impressions: impressionsReelles,
    });
  } catch (err) {
    console.error('Erreur get-campaign-spend :', err);
    return res.status(500).json({ success: false, error: "Impossible de récupérer la consommation pour le moment : " + err.message });
  }
}
