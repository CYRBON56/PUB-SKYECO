// /lib/social-publish.js
// Logique partagée : publier UN post skyeco_pro_social_posts sur Instagram.
// Utilisée par api/social-publish-post.js (déclenchement manuel) et
// api/social-cron-publish.js (posts planifiés, via cron).
//
// Variables d'environnement requises :
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
      `https://graph.facebook.com/v19.0/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    );
    const data = await res.json();
    if (data.status_code === "FINISHED") return true;
    if (data.status_code === "ERROR") return false;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false; // timeout — la vidéo met parfois plus longtemps, à réessayer plus tard
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

  try {
    let creationId;

    if (post.video_url) {
      // --- Vidéo / Reels ---
      const createRes = await fetch(
        `https://graph.facebook.com/v19.0/${igUserId}/media`,
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
        `https://graph.facebook.com/v19.0/${igUserId}/media`,
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
      `https://graph.facebook.com/v19.0/${igUserId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId, access_token: accessToken }),
      }
    );
    const publishData = await publishRes.json();
    if (!publishData.id) throw new Error(JSON.stringify(publishData));

    await fetch(`${SUPABASE_URL}/rest/v1/skyeco_pro_social_posts?id=eq.${postId}`, {
      method: "PATCH",
      headers: headersSupabase(),
      body: JSON.stringify({
        statut: "publie",
        published_at: new Date().toISOString(),
        ig_media_id: publishData.id,
        erreur: null,
      }),
    });

    return { success: true, igMediaId: publishData.id };
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
