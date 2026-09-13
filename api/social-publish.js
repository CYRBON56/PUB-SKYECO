// /lib/social-publish.js
// Logique partagée : publier UN post skyeco_pro_social_posts sur Instagram,
// et — si une Page Facebook est connectée (voir facebook-callback.js), une
// fiche Google Business Profile est configurée, et/ou un compte TikTok est
// connecté (voir tiktok-callback.js) — sur ces canaux également.
// Utilisée par api/social-publish-post.js (déclenchement manuel) et
// api/social-cron-publish.js (posts planifiés, via cron).
//
// Instagram reste le canal principal : si la connexion Instagram est absente
// ou que la publication Instagram échoue, le post est marqué en échec comme
// avant. Facebook, Google Business Profile et TikTok sont des canaux en
// plus, non bloquants : un souci sur l'un d'eux n'empêche pas le post d'être
// marqué "publié" (il l'est déjà sur Instagram) — l'erreur est simplement
// gardée à part (fb_erreur / gbp_erreur / tiktok_erreur) pour affichage dans
// le dashboard.
//
// Publication Google Business Profile : passe par Windsor.ai (même compte
// déjà utilisé pour Google Ads), pas par une API Google directe — voir
// publierSurGoogleBusinessSiConnecte(). Contrairement à Instagram/Facebook,
// la connexion de la fiche Google d'un artisan n'est pas un OAuth self-service
// depuis le dashboard : c'est Cyrille qui la relie une fois via Windsor.ai,
// puis renseigne `google_business_location_id` sur la vitrine concernée.
//
// Publication TikTok : passe par le Content Posting API officiel de TikTok
// (Direct Post) — voir publierSurTikTokSiConnecte(). L'access_token TikTok
// expire au bout de 24h ; cette fonction le rafraîchit automatiquement via
// le refresh_token (valable 365 jours) si besoin, et persiste le nouveau
// couple de jetons sur skyeco_pro_social_connections.
//
// ⚠️ Tant que l'app TikTok de Cyrille n'a pas passé l'audit "Content Posting
// API", TOUS les posts sont forcés en privé (SELF_ONLY) par TikTok, quel que
// soit le réglage demandé — limitation réelle sans contournement côté code.
// Voir aussi : la publication PULL_FROM_URL exige d'avoir vérifié la
// propriété du préfixe d'URL utilisé pour héberger les photos/vidéos (le
// bucket public Supabase Storage) dans le portail TikTok for Developers.
//
// Variables d'environnement requises :
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   WINDSOR_API_KEY (pour Google Business Profile)
//   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET (pour le rafraîchissement TikTok)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WINDSOR_GBP_BASE = "https://connectors.windsor.ai/google_my_business";

function headersSupabase() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function attendreVideoPrete(creationId, accessToken, maxAttentesSec = 90) {
  const debut = Date.now();
  while ((Date.now() - debut) / 1000 < maxAttentesSec) {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    );
    const data = await res.json();
    if (data.status_code === "FINISHED") return true;
    if (data.status_code === "ERROR") return false;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false; // timeout — la vidéo met parfois plus longtemps, à réessayer plus tard
}

// Publie le même contenu sur la Page Facebook connectée, s'il y en a une.
// Ne lève jamais d'exception : retourne { fbMediaId } ou { fbErreur }.
async function publierSurFacebookSiConnecte(connexion, post, legendeComplete) {
  if (!connexion.facebook_page_id || !connexion.facebook_access_token) {
    return {}; // pas de Page Facebook connectée pour cette vitrine — rien à faire
  }

  const pageId = connexion.facebook_page_id;
  const pageToken = connexion.facebook_access_token;

  try {
    let publishRes;
    if (post.video_url) {
      publishRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_url: post.video_url,
          description: legendeComplete,
          access_token: pageToken,
        }),
      });
    } else {
      publishRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: post.photo_url,
          caption: legendeComplete,
          access_token: pageToken,
        }),
      });
    }
    const publishData = await publishRes.json();
    const mediaId = publishData.id || publishData.post_id;
    if (!mediaId) throw new Error(JSON.stringify(publishData));
    return { fbMediaId: mediaId };
  } catch (e) {
    return { fbErreur: (e.message || String(e)).slice(0, 500) };
  }
}

// Publie le même contenu (photo uniquement — Google Business Profile n'accepte
// pas de vidéo sur un post "Nouveautés") sur la fiche Google Business Profile
// de la vitrine, si elle est configurée. Ne lève jamais d'exception : retourne
// { gbpPostId } ou { gbpErreur }.
async function publierSurGoogleBusinessSiConnecte(locationId, post, legendeComplete) {
  if (!locationId || post.video_url) {
    return {}; // pas de fiche configurée, ou post vidéo (non supporté par ce canal) — rien à faire
  }
  if (!process.env.WINDSOR_API_KEY) {
    return { gbpErreur: "WINDSOR_API_KEY manquante côté serveur." };
  }

  try {
    const resp = await fetch(`${WINDSOR_GBP_BASE}/actions?api_key=${process.env.WINDSOR_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: locationId,
        action: "create_local_post",
        params: {
          summary: legendeComplete.slice(0, 1500),
          photo_url: post.photo_url || null,
        },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data));
    const postName = data?.name || data?.post_id || data?.id;
    if (!postName) throw new Error(JSON.stringify(data));
    return { gbpPostId: String(postName) };
  } catch (e) {
    return { gbpErreur: (e.message || String(e)).slice(0, 500) };
  }
}

// Rafraîchit le access_token TikTok si besoin (durée de vie 24h) via le
// refresh_token (durée de vie 365 jours), et persiste le nouveau couple de
// jetons sur skyeco_pro_social_connections. Retourne le access_token à
// utiliser (rafraîchi ou non), ou null si le rafraîchissement a échoué.
async function rafraichirJetonTikTokSiBesoin(connexion) {
  const expireBientot =
    !connexion.tiktok_expires_at || new Date(connexion.tiktok_expires_at).getTime() < Date.now() + 5 * 60 * 1000;

  if (!expireBientot) {
    return connexion.tiktok_access_token;
  }

  if (!connexion.tiktok_refresh_token || !process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) {
    return null;
  }

  const resp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: connexion.tiktok_refresh_token,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) return null;

  const expiresAt = new Date(Date.now() + (data.expires_in - 60 * 30) * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?draft_id=eq.${connexion.draft_id}`, {
    method: "PATCH",
    headers: headersSupabase(),
    body: JSON.stringify({
      tiktok_access_token: data.access_token,
      tiktok_refresh_token: data.refresh_token || connexion.tiktok_refresh_token,
      tiktok_expires_at: expiresAt,
    }),
  });

  return data.access_token;
}

// Publie le même contenu sur le compte TikTok connecté, s'il y en a un.
// Ne lève jamais d'exception : retourne { tiktokPostId, tiktokPrivacy } ou
// { tiktokErreur }.
async function publierSurTikTokSiConnecte(connexion, post, legendeComplete) {
  if (!connexion.tiktok_open_id || !(connexion.tiktok_access_token || connexion.tiktok_refresh_token)) {
    return {}; // pas de compte TikTok connecté pour cette vitrine — rien à faire
  }

  try {
    const accessToken = await rafraichirJetonTikTokSiBesoin(connexion);
    if (!accessToken) {
      throw new Error("Jeton TikTok expiré et impossible à rafraîchir (reconnexion nécessaire).");
    }

    // 1. Interroger creator_info pour connaître les options de confidentialité
    // réellement disponibles — obligatoire avant tout Direct Post. Tant que
    // l'app n'est pas auditée, TikTok ne renverra que SELF_ONLY.
    const creatorRes = await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    });
    const creatorData = await creatorRes.json();
    const options = creatorData?.data?.privacy_level_options || [];
    if (!options.length) throw new Error("creator_info n'a renvoyé aucune option de confidentialité : " + JSON.stringify(creatorData));
    // On préfère la visibilité la plus large disponible ; sur une app non
    // auditée, seule SELF_ONLY sera présente.
    const ordrePreference = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
    const privacyLevel = ordrePreference.find((p) => options.includes(p)) || options[0];

    const postInfoBase = {
      title: legendeComplete.slice(0, 2200),
      privacy_level: privacyLevel,
      disable_comment: false,
    };

    let initRes;
    if (post.video_url) {
      initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          post_info: { ...postInfoBase, disable_duet: false, disable_stitch: false },
          source_info: { source: "PULL_FROM_URL", video_url: post.video_url },
        }),
      });
    } else {
      initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          media_type: "PHOTO",
          post_mode: "DIRECT_POST",
          post_info: { ...postInfoBase, description: legendeComplete.slice(0, 4000), auto_add_music: true },
          source_info: { source: "PULL_FROM_URL", photo_images: [post.photo_url], photo_cover_index: 0 },
        }),
      });
    }
    const initData = await initRes.json();
    const publishId = initData?.data?.publish_id;
    if (!publishId) throw new Error(JSON.stringify(initData));

    return { tiktokPostId: publishId, tiktokPrivacy: privacyLevel };
  } catch (e) {
    return { tiktokErreur: (e.message || String(e)).slice(0, 500) };
  }
}

export async function publierPost(postId) {
  // 1. Charger le post.
  const postRes = await fetch(
    `${SUPABASE_URL}/rest/v1/skyeco_pro_social_posts?id=eq.${postId}&select=*`,
    { headers: headersSupabase() }
  );
  const posts = await postRes.json();
  const post = posts[0];
  if (!post) return { success: false, error: "Post introuvable." };

  // 2. Charger la connexion Instagram de la vitrine concernée.
  const connRes = await fetch(
    `${SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?draft_id=eq.${post.draft_id}&select=*`,
    { headers: headersSupabase() }
  );
  const connexions = await connRes.json();
  const connexion = connexions[0];
  if (!connexion) {
    await marquerEchec(postId, "Aucun compte Instagram connecté pour cette vitrine.");
    return { success: false, error: "Aucun compte Instagram connecté." };
  }

  const igUserId = connexion.ig_business_account_id;
  const accessToken = connexion.access_token;
  const legendeComplete = [post.legende, (post.hashtags || []).join(" ")].filter(Boolean).join("\n\n");

  // 2bis. Charger l'identifiant Windsor.ai de la fiche Google Business Profile
  // de cette vitrine, s'il a été configuré (voir en-tête du fichier).
  let googleLocationId = null;
  try {
    const draftRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${post.draft_id}&select=google_business_location_id`,
      { headers: headersSupabase() }
    );
    const drafts = await draftRes.json();
    googleLocationId = drafts[0]?.google_business_location_id || null;
  } catch (e) {
    // Non bloquant : si cette lecture échoue, on publie simplement sans Google Business Profile.
  }

  try {
    let creationId;

    if (post.video_url) {
      // --- Vidéo / Reels ---
      const createRes = await fetch(
        `https://graph.instagram.com/v21.0/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_type: "REELS",
            video_url: post.video_url,
            caption: legendeComplete,
            access_token: accessToken,
          }),
        }
      );
      const createData = await createRes.json();
      if (!createData.id) throw new Error(JSON.stringify(createData));
      creationId = createData.id;

      const prete = await attendreVideoPrete(creationId, accessToken);
      if (!prete) throw new Error("La vidéo n'a pas fini son traitement à temps (réessayez plus tard).");
    } else {
      // --- Photo ---
      const createRes = await fetch(
        `https://graph.instagram.com/v21.0/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_url: post.photo_url,
            caption: legendeComplete,
            access_token: accessToken,
          }),
        }
      );
      const createData = await createRes.json();
      if (!createData.id) throw new Error(JSON.stringify(createData));
      creationId = createData.id;
    }

    // 3. Publier le container préparé.
    const publishRes = await fetch(
      `https://graph.instagram.com/v21.0/${igUserId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId, access_token: accessToken }),
      }
    );
    const publishData = await publishRes.json();
    if (!publishData.id) throw new Error(JSON.stringify(publishData));

    // 4. En plus d'Instagram, publier sur la Page Facebook, la fiche Google
    // Business Profile et/ou le compte TikTok si connectés — sans jamais
    // faire échouer le post pour ça.
    const { fbMediaId, fbErreur } = await publierSurFacebookSiConnecte(connexion, post, legendeComplete);
    const { gbpPostId, gbpErreur } = await publierSurGoogleBusinessSiConnecte(googleLocationId, post, legendeComplete);
    const { tiktokPostId, tiktokPrivacy, tiktokErreur } = await publierSurTikTokSiConnecte(connexion, post, legendeComplete);

    await fetch(`${SUPABASE_URL}/rest/v1/skyeco_pro_social_posts?id=eq.${postId}`, {
      method: "PATCH",
      headers: headersSupabase(),
      body: JSON.stringify({
        statut: "publie",
        published_at: new Date().toISOString(),
        ig_media_id: publishData.id,
        erreur: null,
        fb_post_id: fbMediaId || null,
        fb_erreur: fbErreur || null,
        gbp_post_id: gbpPostId || null,
        gbp_erreur: gbpErreur || null,
        tiktok_post_id: tiktokPostId || null,
        tiktok_privacy: tiktokPrivacy || null,
        tiktok_erreur: tiktokErreur || null,
      }),
    });

    return {
      success: true,
      igMediaId: publishData.id,
      fbMediaId,
      fbErreur,
      gbpPostId,
      gbpErreur,
      tiktokPostId,
      tiktokPrivacy,
      tiktokErreur,
    };
  } catch (e) {
    await marquerEchec(postId, e.message || String(e));
    return { success: false, error: e.message || String(e) };
  }
}

async function marquerEchec(postId, message) {
  await fetch(`${SUPABASE_URL}/rest/v1/skyeco_pro_social_posts?id=eq.${postId}`, {
    method: "PATCH",
    headers: headersSupabase(),
    body: JSON.stringify({ statut: "echec", erreur: String(message).slice(0, 500) }),
  });
}
