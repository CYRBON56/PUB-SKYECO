// /api/create-meta-ads-campaign.js
// Crée (ou recharge) une campagne Meta Ads (Facebook/Instagram) pour un
// artisan client de Skyeco Pro — pendant Google Ads (voir
// create-google-ads-campaign.js) crée un compte client dédié par artisan,
// Meta Ads utilise ICI UN SEUL compte publicitaire partagé (celui de
// Skyeco Pro / RMS EcoSky), avec UNE CAMPAGNE dédiée par artisan à
// l'intérieur. Voir api/_lib/meta-ads.js pour le détail de cette décision
// (prise avec Cyrille le 14/09/2026) et claude/skyeco-pro-brief-meta-ads-
// architecture.md pour les sources.
//
// PAS ENCORE TESTÉ EN CONDITIONS RÉELLES — comme pour Instagram/Facebook/
// TikTok (social-*), ce fichier ne peut pas être vérifié depuis cette
// session : aucun accès à Meta for Developers ni à Meta Business Manager.
//
// Prérequis côté Cyrille avant le premier test (voir api/_lib/meta-ads.js
// pour le détail des 3 variables d'environnement requises) :
//   1. Dans l'App Meta déjà utilisée pour Instagram/Facebook ("Skyeco Pro
//      Ads API", App ID 1471349045044605) OU une App dédiée : ajouter le
//      produit "Marketing API" et demander les permissions ads_management
//      + ads_read (App Review Meta requis pour un usage en dehors des
//      admins/développeurs/testeurs de l'App).
//   2. Créer (ou choisir) LE compte publicitaire Meta qui hébergera TOUTES
//      les campagnes Skyeco Pro (celui de RMS EcoSky déjà utilisé pour les
//      campagnes existantes, ou un nouveau dédié) — récupérer son ID
//      (visible dans Meta Ads Manager, sans le préfixe "act_").
//   3. Choisir la Page Facebook au nom de laquelle les annonces seront
//      publiées (probablement "Ecosky", ID 243043852219845 — déjà celle
//      utilisée pour les campagnes RMS EcoSky, voir memory/areas/meta-ads.md).
//   4. Générer un jeton système utilisateur de longue durée (Business
//      Manager > Utilisateurs système > jeton avec ads_management +
//      pages_read_engagement sur le compte pub et la Page ci-dessus).
//   5. Renseigner META_ADS_ACCESS_TOKEN / META_AD_ACCOUNT_ID / META_PAGE_ID
//      sur Vercel (pub-skyeco-23ue), puis Redeploy.
//
// Budget : contrôlé par budget_repartition_meta_pourcent (0-100, colonne
// ajoutée le 14/09/2026) — la part du budget publicitaire total de
// l'artisan allouée à Meta (le reste va à Google Ads, inchangé). Reste à
// construire : l'endroit dans le dashboard où l'artisan (ou Cyrille) choisit
// cette répartition — pour l'instant la colonne existe mais rien ne
// l'affiche ni ne la modifie encore côté interface, elle vaut 0 par défaut
// (Meta Ads desactivé) pour ne surprendre aucun artisan existant.
//
// Limitations connues, à traiter plus tard :
//   - Ciblage géographique : seule la zone géocodée (ville identifiée)
//     donne un ciblage précis par rayon (custom_locations). Sans zone
//     géocodable, le repli actuel cible la FRANCE ENTIÈRE (pas de mapping
//     département → clé de ciblage Meta construit pour l'instant,
//     contrairement à Google Ads qui a GEO_TARGET_BY_DEPARTEMENT) — à
//     corriger avant un vrai lancement si beaucoup d'artisans tombent dans
//     ce cas de repli.
//   - Visuel de l'annonce : utilise la 1ère photo ou le logo du brouillon
//     tel quel, sans redimensionnement/recadrage aux formats attendus par
//     Meta (1:1 ou 4:5 recommandés) — à surveiller au premier vrai test,
//     Meta peut refuser ou mal recadrer une image aux mauvaises proportions.

import { appelMetaAds, chercherInterets, idCompte } from './_lib/meta-ads.js';
import { resoudreUrlDestination } from './_lib/destination-vitrine.js';

const TAUX_COMMISSION = 0.30; // synchronisé avec create-google-ads-campaign.js (30% depuis le 10/09/2026)

// Mots-clés de recherche d'intérêts Meta par métier — équivalent du
// KEYWORDS_BY_METIER de create-google-ads-campaign.js, mais ici un seul
// terme large par métier suffit : chercherInterets() interroge la Marketing
// API à la volée (pas de mapping figé vers des IDs d'intérêts, qui ne sont
// pas documentés publiquement par Meta et peuvent changer).
const INTERET_RECHERCHE_PAR_METIER = {
  paysagiste: 'paysagisme',
  piscine: 'piscine',
  tonte: 'jardinage',
  terrasse: 'terrasse',
  paysagiste_concepteur: 'aménagement paysager',
  arboriste: 'élagage',
  espaces_verts: 'espaces verts',
  autre: 'rénovation extérieure',
};

const RAYON_PAR_DEFAUT_KM = 30;
function extraireRayonKm(zoneTexte) {
  const m = String(zoneTexte || '').match(/(\d+)\s*km/i);
  return m ? parseInt(m[1], 10) : RAYON_PAR_DEFAUT_KM;
}

// Même géocodage que create-google-ads-campaign.js (IGN puis repli
// api-adresse.data.gouv.fr) — dupliqué ici plutôt que factorisé pour ne pas
// toucher au fichier Google Ads déjà en production.
const GEOCODAGE_ENDPOINTS = [
  'https://data.geopf.fr/geocodage/search',
  'https://api-adresse.data.gouv.fr/search/',
];
async function geocoderZone(zoneTexte) {
  if (!zoneTexte) return null;
  const nomLieu = String(zoneTexte).replace(/et alentours.*$/i, '').split(',')[0].trim();
  if (!nomLieu) return null;
  for (const base of GEOCODAGE_ENDPOINTS) {
    try {
      const resp = await fetch(`${base}?q=${encodeURIComponent(nomLieu)}&type=municipality&limit=1`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const feature = data && Array.isArray(data.features) ? data.features[0] : null;
      const coords = feature && feature.geometry && feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length !== 2) continue;
      const [longitude, latitude] = coords;
      return { latitude, longitude };
    } catch (e) { /* on tente l'endpoint suivant */ }
  }
  return null;
}

async function construireCiblage(draft) {
  const coordZone = await geocoderZone(draft.zone);
  const geoLocations = coordZone
    ? { custom_locations: [{ latitude: coordZone.latitude, longitude: coordZone.longitude, radius: extraireRayonKm(draft.zone), distance_unit: 'kilometer' }] }
    : { countries: ['FR'] }; // repli France entière — voir limitation en tête de fichier

  const premierMetier = Array.isArray(draft.metier) ? draft.metier[0] : draft.metier;
  const motRecherche = INTERET_RECHERCHE_PAR_METIER[premierMetier] || INTERET_RECHERCHE_PAR_METIER.autre;
  const interets = await chercherInterets(motRecherche, 3);

  return {
    geo_locations: geoLocations,
    age_min: 25,
    age_max: 65,
    ...(interets.length ? { interests: interets.map(i => ({ id: i.id, name: i.name })) } : {}),
  };
}

function premiereImageDisponible(draft) {
  const photos = Array.isArray(draft.photos) ? draft.photos.filter(Boolean) : [];
  if (photos.length) return typeof photos[0] === 'string' ? photos[0] : photos[0].url;
  return draft.logo_url || null;
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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=entreprise,metier,zone,departement,tarif_prix,annonce_titres,annonce_descriptions,photos,logo_url,site_web_existant,mode_vitrine,meta_campaign_id,meta_adset_id,meta_ad_id,budget_repartition_meta_pourcent`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];
    if (!draft) return res.status(404).json({ error: 'Site introuvable.' });
    if (!draft.tarif_prix || draft.tarif_prix <= 0) {
      return res.status(400).json({ error: 'Aucun budget publicitaire payé pour ce site.' });
    }
    if (!draft.budget_repartition_meta_pourcent || draft.budget_repartition_meta_pourcent <= 0) {
      return res.status(400).json({ error: 'Meta Ads désactivé pour cet artisan (répartition à 0%).' });
    }

    const budgetTotalNetEuros = draft.tarif_prix * (1 - TAUX_COMMISSION);
    const budgetMetaEurosParJour = (budgetTotalNetEuros * (draft.budget_repartition_meta_pourcent / 100)) / 30;
    const budgetMetaCentimes = Math.round(budgetMetaEurosParJour * 100);
    if (budgetMetaCentimes < 100) { // Meta refuse les budgets journaliers trop faibles (mini généralement ~1€/jour selon devise)
      return res.status(400).json({ error: 'Le budget journalier Meta Ads calculé est trop faible pour être accepté par Meta.' });
    }

    // Recharge : campagne déjà créée pour cet artisan, on met juste à jour
    // le budget journalier de l'ad set (même logique que la branche
    // "recharge" de create-google-ads-campaign.js).
    if (draft.meta_adset_id) {
      await appelMetaAds(draft.meta_adset_id, { daily_budget: String(budgetMetaCentimes) });
      return res.status(200).json({ success: true, recharge: true });
    }

    const nomBase = draft.entreprise || draft_id;

    // 1. Campagne
    const campagne = await appelMetaAds(`${idCompte()}/campaigns`, {
      name: `Skyeco Pro — ${nomBase}`,
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED', // créée en pause — Cyrille active manuellement après vérification, au premier lancement
      special_ad_categories: JSON.stringify([]),
    });

    // 2. Ciblage + ad set
    const targeting = await construireCiblage(draft);
    const adSet = await appelMetaAds(`${idCompte()}/adsets`, {
      name: `${nomBase} — ciblage`,
      campaign_id: campagne.id,
      daily_budget: String(budgetMetaCentimes),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(targeting),
      status: 'PAUSED',
    });

    // 3. Créatif — destination identique à celle utilisée pour Google Ads
    // (site personnel si l'artisan a choisi "site existant", sinon la
    // vitrine Skyeco — voir _lib/destination-vitrine.js).
    const urlDestination = resoudreUrlDestination(draft, draft_id);
    const titres = Array.isArray(draft.annonce_titres) ? draft.annonce_titres.filter(t => typeof t === 'string' && t.trim()) : [];
    const descriptions = Array.isArray(draft.annonce_descriptions) ? draft.annonce_descriptions.filter(d => typeof d === 'string' && d.trim()) : [];
    const image = premiereImageDisponible(draft);

    const linkData = {
      link: urlDestination,
      message: descriptions[0] || 'Obtenez votre estimation gratuite en 2 minutes.',
      name: titres[0] || (nomBase + ' — Devis gratuit'),
      ...(image ? { picture: image } : {}),
    };
    const creative = await appelMetaAds(`${idCompte()}/adcreatives`, {
      name: `${nomBase} — créatif`,
      object_story_spec: JSON.stringify({ page_id: process.env.META_PAGE_ID, link_data: linkData }),
    });

    // 4. Annonce
    const annonce = await appelMetaAds(`${idCompte()}/ads`, {
      name: `${nomBase} — annonce`,
      adset_id: adSet.id,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: 'PAUSED',
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        meta_campaign_id: campagne.id,
        meta_adset_id: adSet.id,
        meta_ad_id: annonce.id,
        meta_creative_id: creative.id,
        meta_ads_cree_le: new Date().toISOString(),
      }),
    });

    return res.status(200).json({ success: true, campaignId: campagne.id, adSetId: adSet.id, adId: annonce.id });
  } catch (err) {
    console.error('Erreur create-meta-ads-campaign :', err);
    return res.status(500).json({ error: err.message || "Impossible de créer la campagne Meta Ads." });
  }
}
