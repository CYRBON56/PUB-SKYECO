// /api/create-google-ads-campaign.js
// Crée une campagne Google Ads complète (compte client dédié + campagne +
// budget, groupe d'annonces, mots-clés, annonce responsive search) pour un
// artisan client de Skyeco Pro.
//
// RESTRUCTURATION DU 10/09/2026 (avec Cyrille) : jusqu'ici, TOUTES les
// campagnes de TOUS les artisans étaient créées dans le même compte Google
// Ads partagé (784-990-3984 "ECOSKY by RMS"), via Windsor.ai. Nouveau
// fonctionnement : chaque artisan reçoit désormais son PROPRE compte client
// Google Ads, créé automatiquement sous le compte manager (MCC) Skyeco Pro
// 735-335-0497, dans lequel sa campagne est ensuite créée. Deux raisons à
// ce changement :
//   1. Un compte "nouveau" par artisan est ce qui permet de prétendre aux
//      crédits promotionnels Google Ads "nouvel annonceur" et, une fois le
//      statut Google Partners obtenu sur ce MCC, à des crédits Partners
//      distribuables aux clients.
//   2. Windsor.ai (utilisé pour créer les campagnes) n'a AUCUNE action de
//      création de compte (vérifié le 10/09/2026 via list_actions sur le
//      connecteur google_ads — uniquement des actions de gestion de
//      campagnes/groupes/annonces/mots-clés sur des comptes qui existent
//      déjà). La création de compte doit donc passer par un appel direct à
//      l'API Google Ads (voir ./_lib/google-ads-mcc.js) — et comme on est
//      déjà obligé d'y appeler l'API directement pour ça, TOUTE la
//      construction de la campagne (budget, campagne, ciblage géo, groupe
//      d'annonces, mots-clés, annonce) est faite ici en direct plutôt que
//      via Windsor, pour éviter de dépendre de la sélection manuelle de
//      comptes dans l'interface Windsor.ai (qui ne propose pas d'API pour
//      ajouter automatiquement un nouveau compte à la volée).
//
// ATTENTION — point à vérifier au premier vrai test (voir aussi le
// commentaire dans ./_lib/google-ads-mcc.js) : le Developer Token du projet
// Google Cloud "Skyeco Pro AP" avait été obtenu avec le niveau d'accès le
// plus bas ("Explorer"/Test), qui limite les appels API aux seuls "comptes
// de test" Google Ads déclarés comme tels — pas les vrais comptes créés ici.
// Si ce niveau n'a pas été relevé depuis, le tout premier appel
// (creerCompteClient) échouera avec une erreur explicite du type "Test
// developer tokens can only be used with test accounts" : pas un bug de ce
// fichier, un accès à faire relever dans Google Ads > Centre API.
//
// IMPORTANT — chantier PAS encore fait, à prévoir avant de mettre ça en
// route pour un vrai artisan payant : get-campaign-spend.js (dépenses
// affichées sur le dashboard), verifier-soldes-bas.js (pause automatique
// si le budget est épuisé) et pause-campagne-ads.js (bouton
// pause/relance manuel) supposent TOUS encore que la campagne d'un artisan
// se trouve dans le compte partagé 784-990-3984 via Windsor.ai. Avec ce
// changement, il faudra aussi leur apprendre à lire
// google_ads_client_account_id et à interroger le bon compte — sans quoi
// un artisan migré vers un compte dédié n'aurait plus de suivi de dépense
// ni de pause automatique fonctionnels. Pas traité dans ce fichier.
//
// Variables d'environnement requises : voir ./_lib/google-ads-mcc.js
// (GOOGLE_ADS_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN, GOOGLE_ADS_DEVELOPER_TOKEN,
// GOOGLE_ADS_MCC_ID), plus SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.

import { creerCompteClient, mutate } from './_lib/google-ads-mcc.js';

const TAUX_COMMISSION = 0.30; // synchronisé avec les autres fichiers (30% depuis le 10/09/2026)

// Historique conservé tel quel (ciblage géographique) — inchangé par cette
// restructuration, ne dépend pas de Windsor.ai.
const GEO_TARGET_BY_DEPARTEMENT = {
  '56': '9040912', // Morbihan — confirmé par l'API Google Ads le 08/09
  '35': '1006083', // Ille-et-Vilaine — non re-vérifié, repris tel quel
  '29': '1006082', // Finistère — non re-vérifié, repris tel quel
  '22': '1006081', // Côtes-d'Armor — non re-vérifié, repris tel quel
  '44': '1006095', // Loire-Atlantique — non re-vérifié, repris tel quel
};
const GEO_TARGET_FRANCE = '2250'; // dernier repli si aucune zone n'a pu être déterminée

const RAYON_PAR_DEFAUT_KM = 30;

function extraireRayonKm(zoneTexte) {
  const m = String(zoneTexte || '').match(/(\d+)\s*km/i);
  return m ? parseInt(m[1], 10) : RAYON_PAR_DEFAUT_KM;
}

const GEOCODAGE_ENDPOINTS = [
  'https://data.geopf.fr/geocodage/search',
  'https://api-adresse.data.gouv.fr/search/',
];

async function geocoderZone(zoneTexte) {
  if (!zoneTexte) return null;
  const nomLieu = String(zoneTexte)
    .replace(/et alentours.*$/i, '')
    .split(',')[0]
    .trim();
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
    } catch (e) {
      // Endpoint injoignable : on tente le suivant, puis on retombe sur le
      // département/la France si aucun des deux ne répond.
    }
  }
  return null;
}

async function determinerCiblageGeographique(draft) {
  const coordZone = await geocoderZone(draft.zone);
  if (coordZone) {
    return { type: 'proximity', latitude: coordZone.latitude, longitude: coordZone.longitude, radiusKm: extraireRayonKm(draft.zone) };
  }
  const departementCode = draft.departement ? String(draft.departement).trim().toUpperCase() : null;
  const geoTargetConstantId = (departementCode && GEO_TARGET_BY_DEPARTEMENT[departementCode]) || GEO_TARGET_FRANCE;
  return { type: 'location', geoTargetConstantId };
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

function extraireDomaine(urlBrute) {
  if (!urlBrute) return '';
  return String(urlBrute).trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .split('?')[0];
}

function slugifierPourAnnonce(texte, maxLength) {
  return String(texte || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.[a-z]{2,}$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, maxLength);
}

function construirePathsAnnonce(draft) {
  const domaine = extraireDomaine(draft.site_web_existant);
  const path1 = slugifierPourAnnonce(domaine || draft.entreprise, 15) || null;
  const path2 = path1 ? (slugifierPourAnnonce(draft.zone, 15) || null) : null;
  return { path1, path2 };
}

function nettoyerSymbolesInterdits(texte) {
  return String(texte || '').replace(/[()]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Extrait le dernier segment d'un resourceName Google Ads
// ("customers/X/campaigns/123" -> "123", "customers/X/adGroupAds/1~2" ->
// "1~2" — ce format "ad_group_id~ad_id" est le même que celui déjà utilisé
// ailleurs dans le produit, ex. pause-campagne-ads.js).
function idDepuisResourceName(resourceName) {
  const parts = String(resourceName || '').split('/');
  return parts[parts.length - 1] || null;
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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=entreprise,metier,zone,departement,tarif_prix,mots_cles_choisis,annonce_titres,annonce_descriptions,google_ads_campaign_resource,google_ads_ad_group_resource,google_ads_budget_resource,google_ads_client_account_id,campagne_pausee_budget_epuise,site_web_existant`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];
    if (!draft) return res.status(404).json({ error: 'Site introuvable.' });
    if (!draft.tarif_prix || draft.tarif_prix <= 0) {
      return res.status(400).json({ error: 'Aucun budget publicitaire payé pour ce site.' });
    }

    const budgetNetEuros = draft.tarif_prix * (1 - TAUX_COMMISSION);
    const budgetJournalierMicros = Math.round((budgetNetEuros / 30) * 100) * 10_000;

    // Étape 0 (nouvelle, 10/09/2026) : chaque artisan a son propre compte
    // client Google Ads sous le MCC — on le crée une seule fois, à la
    // toute première campagne de ce site, et on ne le recrée JAMAIS
    // ensuite (enregistré immédiatement en base pour éviter d'en créer un
    // second si une étape suivante échoue et que ce endpoint est rappelé).
    let clientAccountId = draft.google_ads_client_account_id;
    if (!clientAccountId) {
      clientAccountId = await creerCompteClient({ nomCompte: `Skyeco Pro — ${draft.entreprise || draft_id}` });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ google_ads_client_account_id: clientAccountId }),
      });
    }

    // Recharge (une campagne existe déjà pour ce compte) : on met juste à
    // jour le budget journalier, et on ne réactive la diffusion que si
    // elle avait été mise en pause automatiquement pour solde épuisé.
    if (draft.google_ads_campaign_resource) {
      if (draft.google_ads_budget_resource) {
        await mutate(clientAccountId, 'campaignBudgets', [{
          update: { resourceName: draft.google_ads_budget_resource, amountMicros: String(budgetJournalierMicros) },
          updateMask: 'amount_micros',
        }]);
      }

      if (draft.campagne_pausee_budget_epuise) {
        await mutate(clientAccountId, 'campaigns', [{
          update: { resourceName: `customers/${clientAccountId}/campaigns/${draft.google_ads_campaign_resource}`, status: 'ENABLED' },
          updateMask: 'status',
        }]);
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
        clientAccountId,
        misAJour: true,
        relanceeAutomatiquement: !!draft.campagne_pausee_budget_epuise,
      });
    }

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

    // 1. Créer le budget, puis la campagne (paused par défaut, sécurité) —
    // deux appels séparés côté API Google Ads (contrairement à Windsor.ai
    // qui faisait les deux en un seul appel "create_campaign").
    const [budgetResult] = await mutate(clientAccountId, 'campaignBudgets', [{
      create: { name: `${nomCampagne} — Budget`, amountMicros: String(budgetJournalierMicros), deliveryMethod: 'STANDARD' },
    }]);
    const budgetResourceName = budgetResult && budgetResult.resourceName;
    if (!budgetResourceName) {
      throw new Error('Impossible de créer le budget de campagne : ' + JSON.stringify(budgetResult));
    }

    const [campagneResult] = await mutate(clientAccountId, 'campaigns', [{
      create: {
        name: nomCampagne,
        advertisingChannelType: 'SEARCH',
        status: 'PAUSED',
        campaignBudget: budgetResourceName,
        manualCpc: {},
        networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      },
    }]);
    const campagneResourceName = campagneResult && campagneResult.resourceName;
    if (!campagneResourceName) {
      throw new Error('Impossible de créer la campagne : ' + JSON.stringify(campagneResult));
    }
    const campaignId = idDepuisResourceName(campagneResourceName);

    // 1bis. Ciblage géographique — sans cette étape, la campagne ne
    // diffuse quasiment jamais (voir historique du 08/09).
    const ciblageGeo = await determinerCiblageGeographique(draft);
    if (ciblageGeo.type === 'proximity') {
      await mutate(clientAccountId, 'campaignCriteria', [{
        create: {
          campaign: campagneResourceName,
          proximity: {
            geoPoint: {
              latitudeInMicroDegrees: Math.round(ciblageGeo.latitude * 1_000_000),
              longitudeInMicroDegrees: Math.round(ciblageGeo.longitude * 1_000_000),
            },
            radius: ciblageGeo.radiusKm,
            radiusUnits: 'KILOMETERS',
          },
        },
      }]);
    } else {
      await mutate(clientAccountId, 'campaignCriteria', [{
        create: { campaign: campagneResourceName, location: { geoTargetConstant: `geoTargetConstants/${ciblageGeo.geoTargetConstantId}` } },
      }]);
    }

    // 2. Créer le groupe d'annonces.
    const [adGroupResult] = await mutate(clientAccountId, 'adGroups', [{
      create: { campaign: campagneResourceName, name: 'Estimation', status: 'PAUSED', type: 'SEARCH_STANDARD' },
    }]);
    const adGroupResourceName = adGroupResult && adGroupResult.resourceName;
    if (!adGroupResourceName) {
      throw new Error(`Impossible de créer le groupe d'annonces (campagne ${campaignId} déjà créée) : ` + JSON.stringify(adGroupResult));
    }
    const adGroupId = idDepuisResourceName(adGroupResourceName);

    // 3. Ajouter les mots-clés (phrase match, plus sûr que broad pour du BTP local).
    await mutate(clientAccountId, 'adGroupCriteria', keywords.map(k => ({
      create: { adGroup: adGroupResourceName, status: 'ENABLED', keyword: { text: k, matchType: 'PHRASE' } },
    })));

    // 4. Créer l'annonce elle-même.
    const titresValides = Array.isArray(draft.annonce_titres)
      ? draft.annonce_titres.filter(t => typeof t === 'string' && t.trim()).map(t => nettoyerSymbolesInterdits(t).substring(0, 30)).slice(0, 3)
      : [];
    const descriptionsValides = Array.isArray(draft.annonce_descriptions)
      ? draft.annonce_descriptions.filter(d => typeof d === 'string' && d.trim()).map(d => nettoyerSymbolesInterdits(d).substring(0, 90)).slice(0, 2)
      : [];

    const urlVitrine = `https://app.skyeco.fr/apercu.html?id=${draft_id}`;
    const { path1, path2 } = construirePathsAnnonce(draft);
    const [annonceResult] = await mutate(clientAccountId, 'adGroupAds', [{
      create: {
        adGroup: adGroupResourceName,
        status: 'PAUSED',
        ad: {
          finalUrls: [urlVitrine],
          responsiveSearchAd: {
            headlines: (titresValides.length ? titresValides : [
              nettoyerSymbolesInterdits(draft.entreprise || 'Devis gratuit').substring(0, 30),
              'Estimation gratuite en ligne',
              'Devis sous 24h',
            ]).map(text => ({ text })),
            descriptions: (descriptionsValides.length ? descriptionsValides : [
              'Obtenez votre estimation en 2 minutes, sans engagement.',
              'Artisan local — réponse rapide garantie.',
            ]).map(text => ({ text })),
            ...(path1 ? { path1 } : {}),
            ...(path2 ? { path2 } : {}),
          },
        },
      },
    }]);
    const adResource = annonceResult && idDepuisResourceName(annonceResult.resourceName);

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        google_ads_campaign_resource: String(campaignId),
        google_ads_ad_group_resource: String(adGroupId),
        google_ads_ad_resource: adResource ? String(adResource) : null,
        google_ads_budget_resource: budgetResourceName,
        google_ads_cree_le: new Date().toISOString(),
        campagne_diffusion_pausee: true,
      }),
    });

    return res.status(200).json({ success: true, campaignId, adGroupId, clientAccountId });
  } catch (err) {
    console.error('Erreur create-google-ads-campaign (API Google Ads directe) :', err);
    return res.status(500).json({ error: err.message });
  }
}
