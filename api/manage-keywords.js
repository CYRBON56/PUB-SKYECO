// /api/manage-keywords.js
// Ajoute, exclut ou retire un mot-clé sur la campagne Google Ads d'un artisan
// (via Windsor.ai). Le groupe d'annonces est toujours résolu côté serveur à
// partir du draftId (jamais transmis par le client) — même logique de
// confiance que pause-campagne-ads.js.
//
// Actions :
//   'add'     — ajoute un mot-clé positif (déclenche les annonces).
//   'exclude' — ajoute un mot-clé négatif sur le groupe d'annonces (bloque
//               les recherches contenant ce terme, sans toucher au reste).
//   'remove'  — retire un mot-clé positif existant (nécessite criterionId,
//               renvoyé par /api/get-google-ads-details).
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_ADS_ACCOUNT_ID

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';
const ACTIONS_VALIDES = ['add', 'exclude', 'remove'];

// Corrigé le 04/09 : ce fichier envoyait l'ID de compte Google Ads tel quel
// (sans tirets), contrairement à tous les autres fichiers api/*.js touchant
// Google Ads depuis le correctif du 03/09 — Windsor.ai attend le format AVEC
// tirets ("784-990-3984"). Passé inaperçu jusqu'ici faute d'avoir exercé ce
// fichier en conditions réelles ; même correctif que create-google-ads-campaign.js.
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

  const { draftId, action, texte, matchType, criterionId } = req.body || {};
  if (!draftId || !ACTIONS_VALIDES.includes(action)) {
    return res.status(400).json({ success: false, error: 'draftId et action ("add", "exclude" ou "remove") requis.' });
  }
  if ((action === 'add' || action === 'exclude') && !texte?.trim()) {
    return res.status(400).json({ success: false, error: 'Le texte du mot-clé est requis.' });
  }
  if (action === 'remove' && !criterionId) {
    return res.status(400).json({ success: false, error: 'criterionId requis pour retirer un mot-clé.' });
  }

  const matchTypeValide = ['BROAD', 'PHRASE', 'EXACT'].includes(matchType) ? matchType : 'PHRASE';

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
      return res.status(404).json({ success: false, error: "Aucune campagne active pour ce site." });
    }

    if (action === 'add') {
      const resultat = await executerAction('push_keywords', {
        ad_group_id: adGroupId,
        keywords: [{ text: texte.trim(), match_type: matchTypeValide }],
        status: 'enabled',
      });
      return res.status(200).json({ success: true, resultat });
    }

    if (action === 'exclude') {
      const resultat = await executerAction('push_negative_keywords', {
        level: 'ad_group',
        ad_group_id: adGroupId,
        keywords: [{ text: texte.trim(), match_type: matchTypeValide }],
      });
      return res.status(200).json({ success: true, resultat });
    }

    // action === 'remove'
    const resultat = await executerAction('remove_keywords', {
      ad_group_id: adGroupId,
      criterion_ids: [String(criterionId)],
    });
    return res.status(200).json({ success: true, resultat });
  } catch (err) {
    console.error('Erreur manage-keywords (Windsor.ai) :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
