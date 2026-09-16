// api/tracker-visite.js
//
// Reçoit les événements du script public/tracking-visites.js, envoyé
// depuis chaque page du tunnel Skyeco Ads.
//
// Requête attendue : POST
//   action "entree" : { action:"entree", sessionId, pid, page, referrer }
//     -> crée une ligne dans visites_tunnel, renvoie { id } pour que la
//        page puisse signaler sa sortie plus tard.
//   action "sortie"  : { action:"sortie", id, dureeSecondes }
//     -> met à jour duree_secondes sur la ligne correspondante.
//
// Envoyé via navigator.sendBeacon, donc le corps arrive en
// Content-Type: text/plain — on le parse nous-mêmes plutôt que de se fier
// à un middleware JSON.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    if (body.action === 'entree') {
      const { sessionId, pid, page, referrer } = body;
      if (!sessionId || !page) {
        return res.status(400).json({ success: false, error: 'sessionId et page requis.' });
      }
      const insResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/visites_tunnel`, {
        method: 'POST',
        headers: { ...supaHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          session_id: String(sessionId).slice(0, 100),
          pid: pid ? String(pid).slice(0, 50) : null,
          page: String(page).slice(0, 200),
          referrer: referrer ? String(referrer).slice(0, 500) : null,
          user_agent: (req.headers['user-agent'] || '').slice(0, 300),
        }),
      });
      if (!insResp.ok) throw new Error('Insertion visites_tunnel impossible : ' + (await insResp.text()));
      const [row] = await insResp.json();
      return res.status(200).json({ success: true, id: row.id });
    }

    if (body.action === 'sortie') {
      const { id, dureeSecondes } = body;
      if (!id) return res.status(400).json({ success: false, error: 'id requis.' });
      const duree = Math.max(0, Math.min(parseInt(dureeSecondes, 10) || 0, 3600));
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/visites_tunnel?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ duree_secondes: duree }),
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'action inconnue (attendu: entree | sortie).' });
  } catch (err) {
    console.error('tracker-visite error:', err);
    // Ne jamais faire échouer bruyamment côté visiteur — le tracking ne
    // doit jamais casser la navigation réelle du prospect.
    return res.status(200).json({ success: false });
  }
}
