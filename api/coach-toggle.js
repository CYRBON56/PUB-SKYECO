// /api/coach-toggle.js
// Permet à l'artisan de mettre le Coach IA Ads en pause (ou de le
// réactiver) depuis son tableau de bord — demandé par Cyrille le 04/09,
// suite à la mise en place du coach capable d'agir seul sur la campagne
// (voir coach-ads.js). Tant que le coach est en pause :
//   - /api/coach-ads ne fait plus AUCUN appel à Claude (ni analyse
//     automatique, ni chat, ni action) pour ce draftId — voir la
//     vérification `coach_ia_pause` en tête de ce fichier.
// Ne touche ni à la diffusion de la campagne (campagne_diffusion_pausee,
// géré par pause-campagne-ads.js) ni à rien d'autre : uniquement le
// coach lui-même.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, pause } = req.body || {};
  if (!draftId || typeof pause !== 'boolean') {
    return res.status(400).json({ success: false, error: 'draftId et pause (booléen) requis.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ coach_ia_pause: pause }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`Échec de la mise à jour Supabase : ${detail}`);
    }
    return res.status(200).json({ success: true, coachIaPause: pause });
  } catch (err) {
    console.error('Erreur coach-toggle :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
