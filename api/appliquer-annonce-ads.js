// /api/appliquer-annonce-ads.js
// Pousse RÉELLEMENT dans Google Ads (via Windsor.ai) le texte d'annonce
// (titres/descriptions) actuellement enregistré dans Supabase pour ce site.
//
// Jusqu'ici (avant le 04/09), modifier ce texte dans mon-dashboard.html
// (panneau "🔎 Votre annonce Google Ads") ne faisait qu'enregistrer dans
// Supabase (colonnes annonce_titres/annonce_descriptions), SANS jamais
// toucher à l'annonce réellement diffusée : create-google-ads-campaign.js
// n'utilise ces colonnes qu'à la toute première création de campagne — sa
// branche "recharge" (campagne déjà existante, voir ce fichier) ne touche
// jamais l'annonce. Demandé par Cyrille le 04/09 après avoir remarqué que
// modifier l'annonce dans le dashboard ne se répercutait pas dans Google Ads
// pour sa campagne RMS EcoSky déjà en ligne.
//
// Windsor.ai n'expose PAS d'action pour MODIFIER une annonce responsive
// search existante (voir list_actions du connecteur google_ads) — seulement
// "create_responsive_search_ad" pour en créer une, et pause_ad/enable_ad
// pour activer/désactiver. On applique donc le changement en créant une
// NOUVELLE annonce avec le texte à jour dans le même groupe d'annonces, puis
// en mettant l'ancienne en pause (Google Ads autorise plusieurs annonces par
// groupe — l'historique de perf de l'ancienne reste consultable, juste plus
// diffusée). La nouvelle annonce reprend le même statut (activée/en pause)
// que la diffusion actuelle, pour ne jamais relancer par surprise une
// diffusion volontairement mise en pause par Cyrille (pause-campagne-ads.js).
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

// Corrigé le 04/09 (RMS EcoSky : "Action Windsor.ai create_responsive_search_ad
// échouée" — Google Ads a refusé l'annonce, policy "SYMBOLS"/PROHIBITED sur
// le caractère "(") — les parenthèses sont interdites dans les titres et
// descriptions Google Ads. Filet de sécurité : on les retire toujours avant
// l'envoi, même si mon-dashboard.html les retire déjà de son texte par
// défaut (genererAnnoncePropos), au cas où l'artisan les aurait tapées à la
// main dans un champ.
function nettoyerSymbolesInterdits(texte) {
  return String(texte || '').replace(/[()]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Le domaine réellement affiché dans l'annonce Google Ads est TOUJOURS celui
// de final_url (app.skyeco.fr) — Google ne permet pas de le remplacer par
// celui de l'artisan (voir échange du 04/09 avec Cyrille). Ce qu'on peut en
// revanche personnaliser, ce sont les deux segments de "chemin" affichés
// après ce domaine (path1/path2, ex. skyeco.fr/menuiserie-dupont) — même
// logique que create-google-ads-campaign.js.
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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire les accents
    .toLowerCase()
    .replace(/\.[a-z]{2,}$/i, '') // retire une extension de domaine finale (.fr, .com...)
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

// Windsor.ai renvoie un texte de confirmation dans data.result ("... (id
// <ad_group_id>~<ad_id>) created successfully..."), pas un champ structuré —
// même correctif que create-google-ads-campaign.js/pause-campagne-ads.js (03/09).
function extraireId(data) {
  if (data && typeof data === 'object') {
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
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId requis.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=google_ads_ad_group_resource,google_ads_ad_resource,annonce_titres,annonce_descriptions,campagne_diffusion_pausee,entreprise,zone,site_web_existant`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    const draft = rows[0];
    if (!draft?.google_ads_ad_group_resource) {
      return res.status(404).json({ success: false, error: 'Aucune campagne Google Ads active pour ce site — le premier lancement utilisera directement ce texte.' });
    }

    const titres = Array.isArray(draft.annonce_titres)
      ? draft.annonce_titres.filter(t => typeof t === 'string' && t.trim()).map(t => nettoyerSymbolesInterdits(t).substring(0, 30)).slice(0, 3)
      : [];
    const descriptions = Array.isArray(draft.annonce_descriptions)
      ? draft.annonce_descriptions.filter(d => typeof d === 'string' && d.trim()).map(d => nettoyerSymbolesInterdits(d).substring(0, 90)).slice(0, 2)
      : [];
    if (titres.length < 3 || descriptions.length < 2) {
      return res.status(400).json({ success: false, error: '3 titres et 2 descriptions sont requis pour créer une annonce Google Ads valide.' });
    }

    const urlVitrine = `https://app.skyeco.fr/apercu.html?id=${draftId}`;
    // Reprend le statut actuel de la diffusion : si Cyrille a mis la
    // campagne en pause lui-même, la nouvelle annonce démarre en pause aussi
    // — jamais de relance par surprise juste en changeant un texte.
    const statutNouvelleAnnonce = draft.campagne_diffusion_pausee ? 'paused' : 'enabled';
    const { path1, path2 } = construirePathsAnnonce(draft);

    const nouvelleAnnonce = await executerAction('create_responsive_search_ad', {
      ad_group_id: draft.google_ads_ad_group_resource,
      headlines: titres,
      descriptions,
      final_url: urlVitrine,
      ...(path1 ? { path1 } : {}),
      ...(path2 ? { path2 } : {}),
      status: statutNouvelleAnnonce,
    });
    const nouvelAdResource = extraireId(nouvelleAnnonce);
    if (!nouvelAdResource) {
      throw new Error(`Impossible d'extraire l'id de la nouvelle annonce créée : ${JSON.stringify(nouvelleAnnonce)}`);
    }

    // Met en pause l'ancienne annonce, si elle existe — jamais deux annonces
    // actives en même temps dans ce groupe, pour ne pas diffuser une version
    // obsolète du texte en parallèle de la nouvelle.
    if (draft.google_ads_ad_resource && draft.google_ads_ad_resource.includes('~')) {
      const [ancienAdGroupId, ancienAdId] = draft.google_ads_ad_resource.split('~');
      try {
        await executerAction('pause_ad', { ad_group_id: ancienAdGroupId, ad_id: ancienAdId });
      } catch (e) {
        // Non bloquant : la nouvelle annonce est déjà créée avec le bon
        // statut même si la mise en pause de l'ancienne échoue (ex : déjà
        // supprimée côté Google Ads) — on continue plutôt que d'échouer
        // toute l'opération pour cette seule étape de nettoyage.
        console.error("Avertissement : impossible de mettre en pause l'ancienne annonce :", e.message);
      }
    }

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ google_ads_ad_resource: String(nouvelAdResource) }),
    });

    return res.status(200).json({ success: true, message: 'Nouvelle annonce appliquée dans Google Ads.', adResource: nouvelAdResource });
  } catch (err) {
    console.error('Erreur appliquer-annonce-ads (Windsor.ai) :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
