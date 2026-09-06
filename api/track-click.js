// /api/track-click.js
// GET /api/track-click?id=PROSPECT_ID
// Marque le prospect comme "cliqué" puis redirige vers la landing page.
// Variable d'environnement requise : SUPABASE_SERVICE_ROLE_KEY
//
// Sécurité (06/09/2026) : ce endpoint acceptait un paramètre "to" et
// redirigeait vers cette valeur SANS AUCUNE VALIDATION NI JETON — même sans
// "id", /api/track-click?to=https://site-malveillant.example redirigeait
// immédiatement (redirection ouverte, exploitable par n'importe qui, sans
// aucun prérequis). Aucun code du dépôt ne génère plus de lien avec "to"
// (voir api/lien.js pour l'équivalent actif, avec destination lue en base) —
// ce endpoint semble orphelin ; la destination est donc désormais fixe.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://wklddwumirkdjkbxvzyj.supabase.co';

export default async function handler(req, res) {
  const { id } = req.query;
  const destination = 'https://skyeco.fr/skyeco-pro-landing-paysagiste.html';

  if (id && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: prospect } = await supabase
        .from('prospects_paysagiste')
        .select('stopped')
        .eq('id', id)
        .single();

      await supabase
        .from('prospects_paysagiste')
        .update({
          clicked_at: new Date().toISOString(),
          statut: prospect && prospect.stopped ? 'clique_stop' : 'clique_actif'
        })
        .eq('id', id);
    } catch (err) {
      console.error('Erreur suivi de clic :', err);
      // On redirige quand même — le suivi ne doit jamais bloquer le prospect.
    }
  }

  res.writeHead(302, { Location: destination });
  res.end();
}
