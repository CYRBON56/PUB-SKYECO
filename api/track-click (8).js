// /api/track-click.js
// GET /api/track-click?id=PROSPECT_ID&to=URL_ENCODEE
// Marque le prospect comme "cliqué" puis redirige vers la landing page.
// Variable d'environnement requise : SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://wklddwumirkdjkbxvzyj.supabase.co';

export default async function handler(req, res) {
  const { id, to } = req.query;
  const destination = to ? decodeURIComponent(to) : 'https://skyeco.fr/skyeco-pro-landing-paysagiste.html';

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
