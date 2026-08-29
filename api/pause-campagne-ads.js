// /api/pause-campagne-ads.js
// Met en pause UNIQUEMENT la diffusion de la campagne Google Ads (via
// Windsor.ai), sans toucher à l'abonnement ni au solde publicitaire déjà
// payé — distinct de pause-subscription.js qui suspend la FACTURATION.
// L'artisan peut relancer la diffusion à tout moment avec la même action.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_ADS_ACCOUNT_ID

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';

async function executerAction(action, params) {
  const resp = await fetch(`${WINDSOR_BASE}/actions?api_key=${process.env.WINDSOR_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: process.env.GOOGLE_ADS_ACCOUNT_ID, action, params }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Action Windsor.ai "${action}" échouée : ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, action } = req.body || {}; // action: 'pause' ou 'reprendre'
  if (!draftId || !['pause', 'reprendre'].includes(action)) {
    return res.status(400).json({ success: false, error: 'draftId et action ("pause" ou "reprendre") requis.' });
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
    const draft = rows[0];

    if (!draft?.google_ads_campaign_resource) {
      return res.status(404).json({ success: false, error: 'Aucune campagne active pour ce site.' });
    }

    const nouveauStatut = action === 'pause' ? 'paused' : 'enabled';
    await executerAction('update_campaign_status', {
      campaign_id: draft.google_ads_campaign_resource,
      status: nouveauStatut,
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ campagne_diffusion_pausee: action === 'pause' }),
    });

    return res.status(200).json({
      success: true,
      message: action === 'pause'
        ? 'Diffusion mise en pause. Votre solde publicitaire reste intact, relancez quand vous voulez.'
        : 'Diffusion relancée.',
    });
  } catch (err) {
    console.error('Erreur pause-campagne-ads :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
