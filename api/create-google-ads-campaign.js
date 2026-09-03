// /api/create-google-ads-campaign.js
// Crée une campagne Google Ads complète (campagne + budget, groupe d'annonces,
// mots-clés, annonce responsive search) via l'API Windsor.ai, qui gère
// elle-même l'authentification OAuth Google Ads en interne.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_ADS_ACCOUNT_ID = "7849903984" (ou "784-990-3984") — le compte
//   ECOSKY by RMS réellement utilisé pour les annonces.
//   Confirmé le 30/08 : 735-335-0497 est un AUTRE compte Google Ads
//   (personnel de Cyrille, suspendu) — ce n'est pas celui-ci. Ne pas
//   remplacer 7849903984 par 7353350497 malgré ce qui a pu être dit plus
//   tôt dans cette conversation.
//
// BUG CORRIGÉ le 03/09 (1ère campagne réelle jamais créée en live, jamais
// détecté avant faute de trafic/paiement réel) : ce fichier retirait les
// tirets avant d'envoyer l'ID de compte à Windsor.ai ("7849903984"). Erreur
// réelle obtenue : "Account 7849903984 is not available. The configured
// accounts are: 784-990-3984." — Windsor.ai attend en réalité le format
// AVEC tirets, exactement comme affiché dans Google Ads. On reformate donc
// systématiquement l'ID en XXX-XXX-XXXX au lieu de retirer les tirets.

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';
const TAUX_COMMISSION = 0.50; // doit rester synchronisé avec les autres fichiers

// Windsor.ai attend l'identifiant de compte Google Ads AVEC tirets
// (format XXX-XXX-XXXX, identique à l'interface Google Ads) — voir le
// commentaire d'en-tête du 03/09. Fonctionne que la variable d'env soit
// stockée avec ou sans tirets.
function formaterCompteGoogleAds(id) {
  const chiffres = String(id || '').replace(/[^0-9]/g, '');
  if (chiffres.length !== 10) return String(id || '').trim();
  return `${chiffres.slice(0, 3)}-${chiffres.slice(3, 6)}-${chiffres.slice(6)}`;
}

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

// Bug corrigé le 03/09 (détecté sur la 1ère fois que l'automatisation
// atteignait cette étape en conditions réelles, RESINE MARBRE SOL/RMS) :
// l'API Windsor.ai ne renvoie PAS un champ structuré "campaign_id" / "id" —
// elle renvoie un texte de confirmation dans data.result, du type "Search
// campaign '...' (id 24207666876) created successfully...". Le code
// cherchait campagne.campaign_id / campagne.id, toujours undefined, ce qui
// envoyait un campaign_id "undefined" à l'étape suivante (create_ad_group),
// rejetée par Windsor.ai avec "campaign_id: Field required" — la campagne,
// elle, avait bien été créée (orpheline, jamais rattachée au dashboard).
// Cette fonction extrait l'id numérique (ou "ad_group_id~ad_id") du texte de
// confirmation, avec repli sur d'éventuels champs structurés si l'API change.
function extraireId(data) {
  if (data && typeof data === 'object') {
    if (data.campaign_id) return String(data.campaign_id);
    if (data.ad_group_id) return String(data.ad_group_id);
    if (data.id) return String(data.id);
    if (typeof data.result === 'string') {
      const m = data.result.match(/\(id[:\s]+([0-9]+(?:~[0-9]+)?)\)/i);
      if (m) return m[1];
    }
  }
  return null;
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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=entreprise,metier,zone,tarif_prix,mots_cles_choisis,annonce_titres,annonce_descriptions,google_ads_campaign_resource,google_ads_ad_group_resource,campagne_pausee_budget_epuise`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];
    if (!draft) return res.status(404).json({ error: 'Site introuvable.' });
    if (!draft.tarif_prix || draft.tarif_prix <= 0) {
      return res.status(400).json({ error: 'Aucun budget publicitaire payé pour ce site.' });
    }

    const budgetNetEuros = draft.tarif_prix * (1 - TAUX_COMMISSION);
    // Bug corrigé le 03/09 (détecté sur la 1ère création réelle en live,
    // PORTALECO) : Google Ads exige un montant multiple de l'unité minimale
    // (10 000 micros = 0,01 €) — erreur réelle obtenue : "A money amount was
    // not a multiple of a minimum unit." On arrondit donc d'abord au centime
    // le plus proche, puis on convertit en micros (au lieu d'arrondir
    // directement des micros bruts, qui ne tombe quasiment jamais sur un
    // multiple de 10 000).
    const budgetJournalierMicros = Math.round((budgetNetEuros / 30) * 100) * 10_000;

    // 03/09 : une campagne existe déjà pour ce site (recharge, pas premier
    // paiement) — on ne recrée JAMAIS une deuxième campagne en double.
    // On met juste à jour le budget journalier, et on ne réactive la
    // diffusion que si elle avait été mise en pause AUTOMATIQUEMENT pour
    // solde épuisé (campagne_pausee_budget_epuise) — jamais si Cyrille
    // l'avait mise en pause lui-même pour une autre raison (voir
    // pause-campagne-ads.js), auquel cas seul lui peut la relancer.
    if (draft.google_ads_campaign_resource) {
      await executerAction('set_campaign_budget', {
        campaign_id: draft.google_ads_campaign_resource,
        budget_type: 'daily',
        amount_micros: budgetJournalierMicros,
      });

      if (draft.campagne_pausee_budget_epuise) {
        await executerAction('enable_campaign', { campaign_id: draft.google_ads_campaign_resource });
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
          method: 'PATCH',
          headers: { ...supaHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ campagne_diffusion_pausee: false, campagne_pausee_budget_epuise: false }),
        });
      }

      return res.status(200).json({
        success: true,
        campaignId: draft.google_ads_campaign_resource,
        adGroupId: draft.google_ads_ad_group_resource,
        misAJour: true,
        relanceeAutomatiquement: !!draft.campagne_pausee_budget_epuise,
      });
    }

    // Priorité aux mots-clés choisis par l'artisan (via l'IA de suggestion
    // dans campagne.html) — sinon on retombe sur la liste fixe par métier.
    const motsClesChoisis = Array.isArray(draft.mots_cles_choisis)
      ? draft.mots_cles_choisis
          .filter(m => typeof m === 'string' && m.trim())
          .map(m => m.trim().substring(0, 80))
          .slice(0, 25)
      : [];

    const metiersListe = Array.isArray(draft.metier) ? draft.metier : (draft.metier ? [draft.metier] : []);
    const keywords = motsClesChoisis.length
      ? [...new Set(motsClesChoisis)]
      : (metiersListe.length
          ? [...new Set(metiersListe.flatMap(m => KEYWORDS_BY_METIER[m] || []))]
          : KEYWORDS_BY_METIER.autre);

    const nomCampagne = `Skyeco Pro — ${draft.entreprise || draft_id}`.substring(0, 254);

    // 1. Créer la campagne (paused par défaut, sécurité).
    const campagne = await executerAction('create_campaign', {
      name: nomCampagne,
      budget_amount_micros: budgetJournalierMicros,
      channel_type: 'search',
      bidding_strategy: 'manual_cpc',
      status: 'paused',
    });
    const campaignId = extraireId(campagne);
    if (!campaignId) {
      throw new Error(`Impossible d'extraire l'id de la campagne créée : ${JSON.stringify(campagne)}`);
    }

    // 2. Créer le groupe d'annonces.
    const adGroup = await executerAction('create_ad_group', {
      campaign_id: campaignId,
      name: 'Estimation',
      status: 'paused',
    });
    const adGroupId = extraireId(adGroup);
    if (!adGroupId) {
      throw new Error(`Impossible d'extraire l'id du groupe d'annonces créé (campagne ${campaignId} déjà créée dans Google Ads) : ${JSON.stringify(adGroup)}`);
    }

    // 3. Ajouter les mots-clés (phrase match, plus sûr que broad pour du BTP local).
    await executerAction('push_keywords', {
      ad_group_id: adGroupId,
      keywords: keywords.map(k => ({ text: k, match_type: 'PHRASE' })),
      status: 'enabled',
    });

    // 4. Créer l'annonce elle-même — textes choisis/modifiés par l'artisan
    // dans l'aperçu d'annonce de campagne.html (colonnes annonce_titres /
    // annonce_descriptions, 31/08), sinon repli sur les textes génériques
    // d'origine si l'artisan n'a jamais ouvert cet aperçu.
    const titresValides = Array.isArray(draft.annonce_titres)
      ? draft.annonce_titres.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().substring(0, 30)).slice(0, 3)
      : [];
    const descriptionsValides = Array.isArray(draft.annonce_descriptions)
      ? draft.annonce_descriptions.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim().substring(0, 90)).slice(0, 2)
      : [];

    const urlVitrine = `https://app.skyeco.fr/apercu.html?id=${draft_id}`;
    const annonce = await executerAction('create_responsive_search_ad', {
      ad_group_id: adGroupId,
      headlines: titresValides.length ? titresValides : [
        `${draft.entreprise || 'Devis gratuit'}`,
        'Estimation gratuite en ligne',
        'Devis sous 24h',
      ],
      descriptions: descriptionsValides.length ? descriptionsValides : [
        'Obtenez votre estimation en 2 minutes, sans engagement.',
        'Artisan local — réponse rapide garantie.',
      ],
      final_url: urlVitrine,
      status: 'paused',
    });
    // Bug corrigé le 03/09 : l'id de l'annonce créée (format Windsor.ai
    // "<ad_group_id>~<ad_id>", voir extraireId) n'était jusqu'ici jamais
    // capturé ni enregistré — impossible ensuite de la réactiver
    // individuellement (action enable_ad, distincte de enable_campaign et
    // enable_ad_group) une fois la campagne validée. Voir aussi
    // pause-campagne-ads.js, qui l'utilise désormais.
    const adResource = extraireId(annonce);

    // Bug corrigé le 03/09 (racine de "je ne vois pas l'annonce dans Google") :
    // la campagne est créée en PAUSE dans Google Ads (ci-dessus, sécurité —
    // en attente de validation avant diffusion réelle), mais rien ne posait
    // jusqu'ici campagne_diffusion_pausee=true côté Supabase. Or c'est CE
    // champ, pas le vrai statut Google Ads, que lit le tableau de bord
    // (get-campaign-spend.js) pour son badge "🟢 Active"/"⏸️ En pause" — la
    // campagne restait donc indéfiniment en pause dans Google Ads tout en
    // s'affichant "Active" sur le dashboard, sans qu'aucun bouton ne signale
    // qu'il fallait cliquer sur "Relancer la diffusion" pour l'activer
    // réellement. On pose maintenant ce champ à true à la création, pour que
    // le dashboard affiche bien "En pause" et propose ce bouton — qui appelle
    // déjà correctement enable_campaign (voir pause-campagne-ads.js).
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        google_ads_campaign_resource: String(campaignId),
        google_ads_ad_group_resource: String(adGroupId),
        google_ads_ad_resource: adResource ? String(adResource) : null,
        google_ads_cree_le: new Date().toISOString(),
        campagne_diffusion_pausee: true,
      }),
    });

    return res.status(200).json({ success: true, campaignId, adGroupId });
  } catch (err) {
    console.error('Erreur create-google-ads-campaign (Windsor.ai) :', err);
    return res.status(500).json({ error: err.message });
  }
}
