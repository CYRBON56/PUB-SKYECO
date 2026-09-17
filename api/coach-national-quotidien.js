// /api/coach-national-quotidien.js
// Tâche planifiée (Vercel Cron) qui lance une fois par jour le coach IA de
// la campagne Google Ads nationale (voir _lib/coach-national-core.js pour
// toute la logique d'analyse/action/garde-fous). Demande de Cyrille du
// 17/09/2026 : une vraie synthèse quotidienne, avec une IA qui gère elle-même
// certains réglages (mots-clés, budget) dans des limites de sécurité.
//
// Configuration requise dans vercel.json :
//   { "path": "/api/coach-national-quotidien", "schedule": "0 6 * * *" }
//   (6h UTC ≈ 7h-8h à Paris selon l'heure d'été/hiver — synthèse prête le
//   matin avant que Cyrille ouvre le dashboard.)
//
// Même protection que les autres tâches planifiées de ce projet (voir
// api/verifier-soldes-bas.js) : Vercel envoie automatiquement l'en-tête
// Authorization: Bearer <CRON_SECRET> sur ses propres appels programmés —
// CRON_SECRET est déjà configuré sur ce projet, aucune nouvelle variable à
// ajouter.
//
// Variables d'environnement requises : CRON_SECRET, + celles de
// coach-national-core.js (ANTHROPIC_API_KEY, WINDSOR_API_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY).

import { lancerAnalyseEtAgir } from './_lib/coach-national-core.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const resultat = await lancerAnalyseEtAgir();
    return res.status(200).json({ success: true, ...resultat });
  } catch (err) {
    console.error('Erreur coach-national-quotidien :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
