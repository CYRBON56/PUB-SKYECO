// /api/social-save-post.js
// Crée ou met à jour un post dans skyeco_pro_social_posts.
//
// Table Supabase attendue (à créer si absente) :
//   create table skyeco_pro_social_posts (
//     id uuid primary key default gen_random_uuid(),
//     draft_id uuid not null references skyeco_pro_vitrine_drafts(id),
//     photo_url text,
//     video_url text,
//     legende text,
//     hashtags text[],
//     statut text not null default 'brouillon',  -- brouillon | planifie | publie | echec
//     scheduled_at timestamptz,
//     published_at timestamptz,
//     ig_media_id text,
//     erreur text,
//     created_at timestamptz default now()
//   );
//
// Variables d'environnement requises :
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (écriture -> service_role obligatoire)
//
// Entrée (POST JSON) :
//   { postId?, draftId, photoUrl?, videoUrl?, legende, hashtags, statut, scheduledAt? }
//   - postId absent => création ; présent => mise à jour de ce post.
//   - statut : 'brouillon' | 'planifie' (scheduledAt requis si 'planifie')

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Méthode non autorisée." });
    return;
  }

  const { postId, draftId, photoUrl, videoUrl, legende, hashtags, statut, scheduledAt } = req.body || {};
  if (!draftId) {
    res.status(400).json({ success: false, error: "draftId manquant." });
    return;
  }
  if (!photoUrl && !videoUrl) {
    res.status(400).json({ success: false, error: "Il faut au moins une photo ou une vidéo." });
    return;
  }
  if (statut === "planifie" && !scheduledAt) {
    res.status(400).json({ success: false, error: "Une date de planification est requise." });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const payload = {
    draft_id: draftId,
    photo_url: photoUrl || null,
    video_url: videoUrl || null,
    legende: legende || "",
    hashtags: Array.isArray(hashtags) ? hashtags : [],
    statut: statut || "brouillon",
    scheduled_at: statut === "planifie" ? scheduledAt : null,
  };
  if (postId) payload.id = postId;

  try {
    const url = postId
      ? `${SUPABASE_URL}/rest/v1/skyeco_pro_social_posts?id=eq.${postId}`
      : `${SUPABASE_URL}/rest/v1/skyeco_pro_social_posts`;
    const method = postId ? "PATCH" : "POST";

    const resp = await fetch(url, {
      method,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    res.status(200).json({ success: true, post: Array.isArray(data) ? data[0] : data });
  } catch (e) {
    console.error("Erreur social-save-post:", e);
    res.status(500).json({ success: false, error: "Impossible d'enregistrer le post pour le moment." });
  }
}
