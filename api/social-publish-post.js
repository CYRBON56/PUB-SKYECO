// /api/social-publish-post.js
// Déclenchement manuel : publie immédiatement un post déjà enregistré
// (bouton "Publier maintenant" ou "Réessayer" dans le dashboard).
//
// Entrée (POST JSON) : { postId }

import { publierPost } from "../lib/social-publish.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Méthode non autorisée." });
    return;
  }
  const { postId } = req.body || {};
  if (!postId) {
    res.status(400).json({ success: false, error: "postId manquant." });
    return;
  }

  const resultat = await publierPost(postId);
  res.status(resultat.success ? 200 : 500).json(resultat);
}
