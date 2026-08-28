// /api/create-google-ads-campaign.js
// Crée une campagne Google Ads complète (campagne + budget, groupe d'annonces,
// mots-clés, annonce responsive search) via l'API Windsor.ai, qui gère
// elle-même l'authentification OAuth Google Ads en interne.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_ADS_ACCOUNT_ID (ex: "7849903984" — le compte ECOSKY by RMS, sans tirets)

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';
const TAUX_COMMISSION = 0.50; // doit rester synchronisé avec les autres fichiers

const KEYWORDS_BY_METIER = {
  paysagiste: ['paysagiste prix', 'aménagement extérieur paysagiste', 'devis paysagiste'],
  piscine: ['pose piscine prix', 'installation piscine devis', 'plage piscine prix'],
  tonte: ['tonte pelouse prix', 'entretien jardin prix', 'tonte gazon devis'],
  terrasse: ['terrasse bois prix', 'terrasse composite prix', 'pose terrasse devis'],
  paysagiste_concepteur: ['paysagiste concepteur prix', 'conception jardin paysagiste', 'plan aménagement extérieur'],
  arboriste: ['élagage prix', 'abattage arbre prix', 'arboriste élagueur devis'],
  espaces_verts: ['entretien espaces verts prix', 'entretien jardin copropriété', 'entreprise espaces verts devis'],
  autre: ['devis travaux extérieur', 'artisan paysagiste devis'],
};

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
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draft_id } = req.body || {};
  if (!draft_id) {
    return res.status(400).json({ error: 'draft_id manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=entreprise,metier,departement,tarif_prix`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];
    if (!draft) return res.status(404).json({ error: 'Site introuvable.' });
    if (!draft.tarif_prix || draft.tarif_prix <= 0) {
      return res.status(400).json({ error: 'Aucun budget publicitaire payé pour ce site.' });
    }

    const budgetNetEuros = draft.tarif_prix * (1 - TAUX_COMMISSION);
    const budgetJournalierMicros = Math.round((budgetNetEuros / 30) * 1_000_000);

    const metiersListe = Array.isArray(draft.metier) ? draft.metier : (draft.metier ? [draft.metier] : []);
    const keywords = metiersListe.length
      ? [...new Set(metiersListe.flatMap(m => KEYWORDS_BY_METIER[m] || []))]
      : KEYWORDS_BY_METIER.autre;

    const nomCampagne = `Skyeco Pro — ${draft.entreprise || draft_id}`.substring(0, 254);

    // 1. Créer la campagne (paused par défaut, sécurité).
    const campagne = await executerAction('create_campaign', {
      name: nomCampagne,
      budget_amount_micros: budgetJournalierMicros,
      channel_type: 'search',
      bidding_strategy: 'manual_cpc',
      status: 'paused',
    });
    const campaignId = campagne.campaign_id || campagne.id;

    // 2. Créer le groupe d'annonces.
    const adGroup = await executerAction('create_ad_group', {
      campaign_id: campaignId,
      name: 'Estimation',
      status: 'paused',
    });
    const adGroupId = adGroup.ad_group_id || adGroup.id;

    // 3. Ajouter les mots-clés (phrase match, plus sûr que broad pour du BTP local).
    await executerAction('push_keywords', {
      ad_group_id: adGroupId,
      keywords: keywords.map(k => ({ text: k, match_type: 'PHRASE' })),
      status: 'enabled',
    });

    // 4. Créer l'annonce elle-même.
    const urlVitrine = `https://pub-skyeco-23ue.vercel.app/apercu.html?id=${draft_id}`;
    await executerAction('create_responsive_search_ad', {
      ad_group_id: adGroupId,
      headlines: [
        `${draft.entreprise || 'Devis gratuit'}`,
        'Estimation gratuite en ligne',
        'Devis sous 24h',
      ],
      descriptions: [
        'Obtenez votre estimation en 2 minutes, sans engagement.',
        'Artisan local — réponse rapide garantie.',
      ],
      final_url: urlVitrine,
      status: 'paused',
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        google_ads_campaign_resource: String(campaignId),
        google_ads_cree_le: new Date().toISOString(),
      }),
    });

    return res.status(200).json({ success: true, campaignId, adGroupId });
  } catch (err) {
    console.error('Erreur create-google-ads-campaign (Windsor.ai) :', err);
    return res.status(500).json({ error: err.message });
  }
}
