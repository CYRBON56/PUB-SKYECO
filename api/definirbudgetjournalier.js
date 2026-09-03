// /api/definir-budget-journalier.js
// Permet à l'artisan de choisir lui-même le montant journalier (€/jour) de
// sa campagne Google Ads, au lieu du calcul automatique (budget mensuel payé
// / 30) appliqué à la création — demandé par Cyrille le 03/09 pour pouvoir
// régler ce montant depuis mon-dashboard.html, comme il l'a fait à la main
// dans Google Ads (ex : 20€/jour) pour RMS ECOSKY.
//
// Ce montant est le montant RÉEL envoyé à Google Ads (celui que Google
// dépense), pas le budget mensuel payé par l'artisan (tarif_prix) — aucun
// calcul de commission ici, contrairement à create-google-ads-campaign.js.
// Aucun garde-fou de montant maximum n'est imposé : si l'artisan choisit un
// montant journalier élevé, son solde publicitaire prépayé s'épuisera
// simplement plus vite, et la campagne se met alors en pause automatiquement
// (voir get-campaign-spend.js) — jamais de risque de dépense au-delà de ce
// qui a été payé.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_ADS_ACCOUNT_ID

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';

// Windsor.ai attend l'identifiant de compte Google Ads AVEC tirets
// (format XXX-XXX-XXXX) — même correctif que create-google-ads-campaign.js
// et pause-campagne-ads.js (03/09).
function formaterCompteGoogleAds(id) {
  const chiffres = String(id || '').replace(/[^0-9]/g, '');
  if (chiffres.length !== 10) return String(id || '').trim();
  return `${chiffres.slice(0, 3)}-${chiffres.slice(3, 6)}-${chiffres.slice(6)}`;
}

async function executerAction(action, params) {
  const accountId = formaterCompteGoogleAds(process.env.GOOGLE_ADS_ACCOUNT_ID);
  const resp = await fetch(`${WINDSOR_BASE}/actions?api_key=${process.env.WINDSOR_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: accountId, action, params }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Action Windsor.ai "${action}" échouée : ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, budgetJournalier } = req.body || {};
  const montant = parseFloat(budgetJournalier);
  if (!draftId || !montant || montant <= 0) {
    return res.status(400).json({ success: false, error: 'draftId et budgetJournalier (montant en €, > 0) requis.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=google_ads_campaign_resource`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    const campaignId = rows[0]?.google_ads_campaign_resource;
    if (!campaignId) {
      return res.status(404).json({ success: false, error: 'Aucune campagne active pour ce site.' });
    }

    // Google Ads exige un montant multiple de l'unité minimale
    // (10 000 micros = 0,01 €) — même correctif que create-google-ads-campaign.js
    // (03/09) : on arrondit au centime le plus proche avant de convertir en
    // micros.
    const montantMicros = Math.round(montant * 100) * 10_000;

    await executerAction('set_campaign_budget', {
      campaign_id: campaignId,
      budget_type: 'daily',
      amount_micros: montantMicros,
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ budget_journalier_manuel: montant }),
    });

    return res.status(200).json({ success: true, budgetJournalier: montant });
  } catch (err) {
    console.error('Erreur definir-budget-journalier (Windsor.ai) :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
