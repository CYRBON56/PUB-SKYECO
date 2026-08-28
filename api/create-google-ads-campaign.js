// api/create-google-ads-campaign.js
//
// Crée une VRAIE campagne Google Ads pour un artisan, via l'API Google Ads
// officielle (REST), déclenchée quand il clique sur "Créer mon annonce".
//
// Architecture retenue : UN SEUL compte Google Ads (le tien, RMS EcoSky),
// géré depuis ton compte Manager (MCC). Chaque artisan obtient sa propre
// campagne À L'INTÉRIEUR de ce compte, identifiable par son nom
// ("Skyeco — <entreprise> — <métier>") — pas un compte Ads séparé par
// artisan. C'est cohérent avec le paiement déjà géré via Stripe : c'est toi
// qui payes Google, l'artisan te paye via le checkout existant.
//
// Variables d'environnement requises :
//   GOOGLE_ADS_DEVELOPER_TOKEN
//   GOOGLE_ADS_CLIENT_ID
//   GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_REFRESH_TOKEN
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   (le compte Manager, ex: 7353350497, sans tirets)
//   GOOGLE_ADS_CUSTOMER_ID         (le compte client sous lequel créer les campagnes, sans tirets)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Requête attendue : POST
//   Body: { draft_id: "<uuid du brouillon skyeco_pro_vitrine_drafts>" }

const GOOGLE_ADS_API_VERSION = 'v18';
const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

// Mêmes mots-clés que l'estimation de clics (api/estimate-reach.js), pour
// rester cohérent entre l'estimation annoncée et la campagne réellement créée.
const KEYWORDS_BY_METIER = {
  paysagiste: ['paysagiste prix', 'aménagement extérieur paysagiste', 'devis paysagiste'],
  piscine: ['pose piscine prix', 'installation piscine devis', 'plage piscine prix'],
  tonte: ['tonte pelouse prix', 'entretien jardin prix', 'tonte gazon devis'],
  terrasse: ['terrasse bois prix', 'terrasse composite prix', 'pose terrasse devis'],
  paysagiste_concepteur: ['paysagiste concepteur prix', 'conception jardin paysagiste', 'plan aménagement extérieur'],
  arboriste: ['élagage prix', 'abattage arbre prix', 'arboriste élagueur devis'],
  espaces_verts: ['entretien espaces verts prix', 'entretien jardin copropriété', 'entreprise espaces verts devis'],
  autre: ['devis travaux extérieur', 'artisan paysagiste devis']
};

// Codes de ciblage géographique Google Ads par département français
// (identifiants "geoTargetConstants" officiels Google, niveau département).
// Table volontairement partielle ici — à compléter au fur et à mesure des
// départements réellement utilisés, ou à remplacer par un appel à
// GeoTargetConstantService.suggestGeoTargetConstants si besoin d'exhaustivité.
const GEO_TARGET_BY_DEPARTEMENT = {
  '56': '1006094', // Morbihan
  '35': '1006083', // Ille-et-Vilaine
  '29': '1006082', // Finistère
  '22': '1006081', // Côtes-d'Armor
  '44': '1006095', // Loire-Atlantique
  // TODO: compléter avec les autres départements au besoin
};

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

function headersGoogleAds(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    'Content-Type': 'application/json',
  };
}

async function mutateGoogleAds(accessToken, service, operations) {
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const resp = await fetch(
    `${GOOGLE_ADS_BASE_URL}/customers/${customerId}/${service}:mutate`,
    {
      method: 'POST',
      headers: headersGoogleAds(accessToken),
      body: JSON.stringify({ operations }),
    }
  );
  const data = await resp.json();
  if (!resp.ok) {
    console.error(`Google Ads API erreur (${service}) :`, JSON.stringify(data));
    throw new Error(data.error?.message || `Échec ${service}`);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée.' });
  }

  const { draft_id } = req.body || {};
  if (!draft_id) {
    return res.status(400).json({ success: false, error: 'Identifiant de site manquant.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Récupère les infos du site (métier, entreprise, budget, zone/département).
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=*`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }
    if (!draft.tarif_actif || !draft.tarif_prix) {
      return res.status(400).json({ success: false, error: 'Budget publicitaire manquant sur ce site.' });
    }

    // Le client paye le montant brut (ex: 300€), mais seule la part restante
    // après la commission de service de 20% part réellement en dépense
    // publicitaire — cohérent avec le calcul déjà fait dans estimate-reach.js.
    const TAUX_COMMISSION = 0.50; // 50% pour l'instant
    const budgetPayeEuros = parseFloat(draft.tarif_prix);
    const budgetMensuelEuros = +(budgetPayeEuros * (1 - TAUX_COMMISSION)).toFixed(2);
    const budgetJournalierMicros = Math.round((budgetMensuelEuros / 30.4) * 1_000_000);
    const metiersListe = Array.isArray(draft.metier) ? draft.metier : (draft.metier ? [draft.metier] : []);
    const keywords = metiersListe.length
      ? [...new Set(metiersListe.flatMap(m => KEYWORDS_BY_METIER[m] || []))]
      : KEYWORDS_BY_METIER.autre;
    const geoTargetId = GEO_TARGET_BY_DEPARTEMENT[draft.departement];

    const accessToken = await obtenirAccessToken();
    const nomCampagne = `Skyeco — ${draft.entreprise} — ${draft.metier} — ${draft.id.slice(0, 8)}`;

    // 2. Crée le budget de la campagne.
    const budgetRes = await mutateGoogleAds(accessToken, 'campaignBudgets', [{
      create: {
        name: `Budget — ${nomCampagne}`,
        amountMicros: String(budgetJournalierMicros),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    }]);
    const budgetResourceName = budgetRes.results[0].resourceName;

    // 3. Crée la campagne (Search, en pause au départ — activation manuelle
    //    recommandée après vérification, plutôt qu'un lancement automatique).
    const campagneRes = await mutateGoogleAds(accessToken, 'campaigns', [{
      create: {
        name: nomCampagne,
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: budgetResourceName,
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: false,
          targetContentNetwork: false,
        },
        manualCpc: {},
      },
    }]);
    const campagneResourceName = campagneRes.results[0].resourceName;

    // 4. Ciblage géographique par département, si connu.
    if (geoTargetId) {
      await mutateGoogleAds(accessToken, 'campaignCriteria', [{
        create: {
          campaign: campagneResourceName,
          location: { geoTargetConstant: `geoTargetConstants/${geoTargetId}` },
        },
      }]);
    }

    // 5. Ciblage langue (français).
    await mutateGoogleAds(accessToken, 'campaignCriteria', [{
      create: {
        campaign: campagneResourceName,
        language: { languageConstant: 'languageConstants/1002' }, // 1002 = French
      },
    }]);

    // 6. Crée le groupe d'annonces.
    const groupeRes = await mutateGoogleAds(accessToken, 'adGroups', [{
      create: {
        name: `Groupe — ${draft.metier}`,
        campaign: campagneResourceName,
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
      },
    }]);
    const groupeResourceName = groupeRes.results[0].resourceName;

    // 7. Ajoute les mots-clés (correspondance large modifiée, par défaut).
    await mutateGoogleAds(accessToken, 'adGroupCriteria', keywords.map((mot) => ({
      create: {
        adGroup: groupeResourceName,
        status: 'ENABLED',
        keyword: { text: mot, matchType: 'BROAD' },
      },
    })));

    // 8. Crée l'annonce responsive search (titres/descriptions génériques —
    //    à affiner manuellement ensuite dans l'interface Google Ads).
    const lienVitrine = `https://pub-skyeco-23ue.vercel.app/apercu.html?id=${draft.id}`;
    await mutateGoogleAds(accessToken, 'adGroupAds', [{
      create: {
        adGroup: groupeResourceName,
        status: 'PAUSED', // à activer après relecture humaine des textes
        ad: {
          finalUrls: [lienVitrine],
          responsiveSearchAd: {
            headlines: [
              { text: `${draft.entreprise}` },
              { text: 'Devis gratuit en ligne' },
              { text: 'Réponse sous 24h' },
            ],
            descriptions: [
              { text: 'Obtenez votre estimation en 2 minutes, sans engagement.' },
              { text: 'Artisan local — devis rapide et sans surprise.' },
            ],
          },
        },
      },
    }]);

    // 9. Marque le site comme ayant une campagne créée.
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        google_ads_campaign_resource: campagneResourceName,
        google_ads_cree_le: new Date().toISOString(),
      }),
    });

    return res.status(200).json({
      success: true,
      message: "Campagne créée avec succès, en PAUSE — à vérifier et activer manuellement dans Google Ads avant diffusion.",
      campagne: campagneResourceName,
    });
  } catch (err) {
    console.error('create-google-ads-campaign error:', err);
    return res.status(500).json({ success: false, error: 'Création de la campagne impossible : ' + err.message });
  }
}
