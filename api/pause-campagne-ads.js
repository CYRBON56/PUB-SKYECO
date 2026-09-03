// /api/pause-campagne-ads.js
// Met en pause UNIQUEMENT la diffusion de la campagne Google Ads (via
// Windsor.ai), sans toucher à l'abonnement ni au solde publicitaire déjà
// payé — distinct de pause-subscription.js qui suspend la FACTURATION.
// L'artisan peut relancer la diffusion à tout moment avec la même action.
//
// Bug corrigé le 03/09 (jamais détecté avant faute de campagne réelle en
// trafic) : ce fichier appelait une action Windsor.ai "update_campaign_status"
// qui n'existe pas — la vraie liste d'actions Google Ads de Windsor.ai
// n'expose que "pause_campaign" et "enable_campaign" (chacune sans autre
// paramètre que campaign_id), pas d'action générique par "status". Tout
// appel à ce endpoint échouait donc silencieusement côté serveur (erreur
// Windsor.ai capturée par le catch, jamais un vrai pause/reprise appliqué).
//
// 2e bug corrigé le 03/09 (même jour, détecté sur la 1ère campagne réelle
// créée en live) : l'ID de compte Google Ads était envoyé à Windsor.ai SANS
// tirets ("7849903984"), alors que Windsor.ai attend le format AVEC tirets
// ("784-990-3984", identique à l'affichage Google Ads) — erreur réelle :
// "Account 7849903984 is not available. The configured accounts are:
// 784-990-3984." Voir create-google-ads-campaign.js pour le même correctif.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_ADS_ACCOUNT_ID

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';

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

    await executerAction(action === 'pause' ? 'pause_campaign' : 'enable_campaign', {
      campaign_id: draft.google_ads_campaign_resource,
    });

    // Une pause déclenchée ICI est toujours une décision MANUELLE de Cyrille
    // (bouton du dashboard) — on efface donc systématiquement le marqueur
    // "pause automatique pour solde épuisé" (campagne_pausee_budget_epuise),
    // qu'on soit en train de mettre en pause ou de reprendre : une reprise
    // manuelle relance toujours, et une pause manuelle ne doit plus être
    // relancée automatiquement par une future recharge (voir
    // create-google-ads-campaign.js) — seul Cyrille pourra la relancer.
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ campagne_diffusion_pausee: action === 'pause', campagne_pausee_budget_epuise: false }),
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
