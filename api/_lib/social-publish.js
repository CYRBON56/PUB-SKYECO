// /api/_lib/social-publish.js
// Fonctions de publication par réseau, utilisées par l'agent IA
// (agent-reseaux-sociaux.js) — 27/09/2026.
//
// Chaque fonction reçoit la ligne de connexion Supabase
// (skyeco_pro_social_connections) et { legende, photoUrl }, publie, et
// renvoie l'identifiant du post créé sur la plateforme. Si le réseau n'est
// pas connecté (jeton manquant), la fonction lève une erreur explicite —
// c'est à l'appelant de ne PAS appeler une fonction pour un réseau non
// connecté (voir estConnecte ci-dessous), afin de ne jamais faire échouer
// silencieusement un post entier à cause d'un seul réseau manquant.
//
// Tant que les apps Meta/TikTok/Google/Pinterest ne sont pas approuvées
// (App Review), ces appels échoueront avec une erreur de permission
// explicite de la plateforme — c'est attendu, pas un bug côté code : voir
// le récapitulatif "pré-requis" en tête de chaque fichier *-connect-start.js.

export function estConnecte(connexion, reseau) {
  if (!connexion) return false;
  switch (reseau) {
    case 'facebook': return !!connexion.facebook_page_id && !!connexion.facebook_access_token;
    case 'instagram': return !!connexion.ig_business_account_id && !!connexion.access_token;
    case 'google_business': return !!connexion.google_business_location_id && !!connexion.google_business_access_token;
    case 'tiktok': return !!connexion.tiktok_open_id && !!connexion.tiktok_access_token;
    case 'pinterest': return !!connexion.pinterest_board_id && !!connexion.pinterest_access_token;
    default: return false;
  }
}

export function reseauxConnectes(connexion) {
  return ['facebook', 'instagram', 'google_business', 'tiktok', 'pinterest'].filter(r => estConnecte(connexion, r));
}

async function supabasePatchConnexion(draftId, champs) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?draft_id=eq.${draftId}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(champs),
  });
}

// --- Facebook ---------------------------------------------------------

export async function publierFacebook(connexion, { legende, photoUrl }) {
  const resp = await fetch(`https://graph.facebook.com/v21.0/${connexion.facebook_page_id}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: photoUrl, caption: legende, access_token: connexion.facebook_access_token }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Facebook : ${data?.error?.message || JSON.stringify(data)}`);
  return data.post_id || data.id;
}

// --- Instagram (via le même jeton de Page que Facebook) ---------------

export async function publierInstagram(connexion, { legende, photoUrl }) {
  const creationResp = await fetch(`https://graph.facebook.com/v21.0/${connexion.ig_business_account_id}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: photoUrl, caption: legende, access_token: connexion.access_token }),
  });
  const creationData = await creationResp.json();
  if (!creationResp.ok || !creationData.id) throw new Error(`Instagram (création) : ${creationData?.error?.message || JSON.stringify(creationData)}`);

  const publishResp = await fetch(`https://graph.facebook.com/v21.0/${connexion.ig_business_account_id}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationData.id, access_token: connexion.access_token }),
  });
  const publishData = await publishResp.json();
  if (!publishResp.ok) throw new Error(`Instagram (publication) : ${publishData?.error?.message || JSON.stringify(publishData)}`);
  return publishData.id;
}

// --- Google Business Profile -------------------------------------------

async function rafraichirGoogleBusinessSiExpire(draftId, connexion) {
  const expireDans5min = !connexion.google_business_expires_at || new Date(connexion.google_business_expires_at).getTime() - Date.now() < 5 * 60 * 1000;
  if (!expireDans5min) return connexion.google_business_access_token;
  if (!connexion.google_business_refresh_token) throw new Error('Google Business Profile : jeton expiré et aucun refresh_token disponible — reconnexion nécessaire.');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET,
      refresh_token: connexion.google_business_refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error(`Google Business Profile : échec du rafraîchissement du jeton — ${JSON.stringify(data)}`);

  const nouvelleExpiration = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  await supabasePatchConnexion(draftId, { google_business_access_token: data.access_token, google_business_expires_at: nouvelleExpiration });
  return data.access_token;
}

export async function publierGoogleBusiness(draftId, connexion, { legende, photoUrl }) {
  const jeton = await rafraichirGoogleBusinessSiExpire(draftId, connexion);
  const resp = await fetch(`https://mybusiness.googleapis.com/v4/${connexion.google_business_location_id}/localPosts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      languageCode: 'fr',
      summary: legende,
      topicType: 'STANDARD',
      media: photoUrl ? [{ mediaFormat: 'PHOTO', sourceUrl: photoUrl }] : undefined,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Google Business Profile : ${data?.error?.message || JSON.stringify(data)}`);
  return data.name;
}

// --- TikTok --------------------------------------------------------------

async function rafraichirTikTokSiExpire(draftId, connexion) {
  const expireDans5min = !connexion.tiktok_expires_at || new Date(connexion.tiktok_expires_at).getTime() - Date.now() < 5 * 60 * 1000;
  if (!expireDans5min) return connexion.tiktok_access_token;
  if (!connexion.tiktok_refresh_token) throw new Error('TikTok : jeton expiré et aucun refresh_token disponible — reconnexion nécessaire.');

  const resp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: connexion.tiktok_refresh_token,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error(`TikTok : échec du rafraîchissement du jeton — ${JSON.stringify(data)}`);

  const nouvelleExpiration = new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString();
  await supabasePatchConnexion(draftId, {
    tiktok_access_token: data.access_token,
    tiktok_refresh_token: data.refresh_token || connexion.tiktok_refresh_token,
    tiktok_expires_at: nouvelleExpiration,
  });
  return data.access_token;
}

// Publie une PHOTO (pas une vidéo) via la Content Posting API — post direct,
// visibilité "SELF_ONLY" par défaut tant que l'app n'a pas l'audit complet
// TikTok (voir tiktok-connect-start.js) ; passer à PUBLIC_TO_EVERYONE une
// fois l'app auditée.
export async function publierTikTok(draftId, connexion, { legende, photoUrl }) {
  const jeton = await rafraichirTikTokSiExpire(draftId, connexion);
  const resp = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_info: {
        title: legende,
        privacy_level: 'SELF_ONLY',
        disable_comment: false,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        photo_images: [photoUrl],
      },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
    }),
  });
  const data = await resp.json();
  if (!resp.ok || data?.error?.code !== 'ok') throw new Error(`TikTok : ${data?.error?.message || JSON.stringify(data)}`);
  return data?.data?.publish_id;
}

// --- Pinterest -----------------------------------------------------------

export async function publierPinterest(connexion, { legende, photoUrl }) {
  const resp = await fetch('https://api.pinterest.com/v5/pins', {
    method: 'POST',
    headers: { Authorization: `Bearer ${connexion.pinterest_access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      board_id: connexion.pinterest_board_id,
      title: legende.slice(0, 100),
      description: legende,
      media_source: { source_type: 'image_url', url: photoUrl },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Pinterest : ${data?.message || JSON.stringify(data)}`);
  return data.id;
}
