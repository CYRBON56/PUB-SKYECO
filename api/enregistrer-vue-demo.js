// /api/enregistrer-vue-demo.js
//
// POST /api/enregistrer-vue-demo
//   body: { draftId, sessionId }
//
// Enregistre une vue du tableau de bord démo (public/mon-dashboard-demo.html)
// pour un artisan/prospect donné (draftId), une seule fois par session
// navigateur (sessionId généré côté client, voir mon-dashboard-demo.html).
// Sert uniquement à alimenter le compteur "👀 X vues démo" affiché dans
// mes-artisans.html (api/mes-artisans.js, action 'liste').
//
// N'est appelé QUE quand la démo est ouverte avec un ?id=<draftId> réel
// (artisan déjà identifié) — jamais en mode générique sans id ou en mode
// "?visiteur=1" (pas encore d'artisan à qui rattacher la vue).
//
// Table dédiée (pas d'écriture en clé anonyme, cohérent avec le reste du
// projet) : voir sql-creation-skyeco-pro-demo-vues.sql, contrainte unique
// (draft_id, session_id) -> un doublon est silencieusement ignoré.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, sessionId } = req.body || {};
  if (!draftId || !sessionId) {
    return res.status(400).json({ success: false, error: 'draftId et sessionId requis' });
  }

  try {
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_demo_vues`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        // Un doublon (draft_id, session_id) ne doit jamais faire échouer
        // l'appel : on l'ignore silencieusement plutôt que d'upsert (pas
        // besoin de mettre à jour created_at sur une visite déjà connue).
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({ draft_id: draftId, session_id: sessionId }),
    });

    if (!resp.ok && resp.status !== 409) {
      throw new Error('Écriture impossible : ' + (await resp.text()));
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('enregistrer-vue-demo error:', e);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
}
