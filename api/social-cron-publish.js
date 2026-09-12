// /api/social-cron-publish.js
// À appeler périodiquement (Vercel Cron, voir vercel.json) pour publier les
// posts dont scheduled_at est passé et statut = 'planifie'.
//
// Variables d'environnement requises :
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   CRON_SECRET   - protège l'endpoint (Vercel Cron envoie ce secret en header)

import { publierPost } from "../lib/social-publish.js";

export default async function handler(req, res) {
  // Vercel Cron ajoute automatiquement ce header quand CRON_SECRET est défini
  // dans les settings du projet — évite qu'un tiers déclenche l'endpoint.
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ success: false, error: "Non autorisé." });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const nowIso = new Date().toISOString();
    const dueRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_social_posts?statut=eq.planifie&scheduled_at=lte.${encodeURIComponent(nowIso)}&select=id`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const duePosts = await dueRes.json();

    const resultats = [];
    for (const p of duePosts) {
      const r = await publierPost(p.id);
      resultats.push({ postId: p.id, ...r });
    }

    res.status(200).json({ success: true, traites: resultats.length, resultats });
  } catch (e) {
    console.error("Erreur social-cron-publish:", e);
    res.status(500).json({ success: false, error: "Erreur lors du traitement des posts planifiés." });
  }
}
