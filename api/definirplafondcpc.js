// /api/definir-plafond-cpc.js
// Permet à l'artisan de plafonner lui-même le CPC (coût par clic) max de son
// groupe d'annonces — demandé par Cyrille le 04/09 ("je ne veux pas que ça
// dépasse tant du clic"), en complément du plafond de dépense JOURNALIÈRE
// (definir-budget-journalier.js) : celui-ci limite le prix payé pour UN
// clic, l'autre limite le total dépensé sur UNE journée. Les deux sont
// indépendants et peuvent être réglés séparément.
//
// N'a d'effet que sur une campagne en enchères manuelles (bidding_strategy
// 'manual_cpc', réglage par défaut de create-google-ads-campaign.js). Sur
// une stratégie d'enchères automatique (Maximiser les clics/conversions...),
// Google Ads ignore le CPC max par groupe d'annonces — l'action Windsor.ai
// set_max_cpc échoue alors avec une erreur explicite, remontée telle quelle.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_ADS_ACCOUNT_ID

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';

// Windsor.ai attend l'identifiant de compte Google Ads AVEC tirets
// (format XXX-XXX-XXXX) — même correctif que les autres fichiers api/*.js
// touchant Google Ads (03/09).
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

  const { draftId, plafondCpc } = req.body || {};
  const montant = parseFloat(plafondCpc);
  if (!draftId || !montant || montant <= 0) {
    return res.status(400).json({ success: false, error: 'draftId et plafondCpc (montant en €, > 0) requis.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=google_ads_ad_group_resource`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    const adGroupId = rows[0]?.google_ads_ad_group_resource;
    if (!adGroupId) {
      return res.status(404).json({ success: false, error: 'Aucune campagne active pour ce site.' });
    }

    // Google Ads exige un montant multiple de l'unité minimale
    // (10 000 micros = 0,01 €) — même correctif que
    // create-google-ads-campaign.js/definir-budget-journalier.js (03/09).
    const montantMicros = Math.round(montant * 100) * 10_000;

    await executerAction('set_max_cpc', {
      ad_group_id: adGroupId,
      amount_micros: montantMicros,
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ plafond_cpc_manuel: montant }),
    });

    return res.status(200).json({ success: true, plafondCpc: montant });
  } catch (err) {
    console.error('Erreur definir-plafond-cpc (Windsor.ai) :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
