// api/ping-presence-prospect.js
//
// POST /api/ping-presence-prospect   body: { prospectId }
//
// Ping léger envoyé par skyeco-pro-formulaire-creation.html toutes les 30s
// tant que l'onglet est visible, quand la page a été ouverte via le lien de
// tracking de prospection (/l?p=... -> voir api/lien.js, qui ajoute
// ?pp=<id> à la destination). Horodate prospects_paysagiste.dernier_ping,
// utilisé par prospects-paysagiste.html pour afficher "en ce moment sur le
// site" parmi les artisans démarchés par email (18/09/2026 — demande de
// Cyrille : voir, dans le suivi des emails de prospection ouverts, si l'un
// des destinataires est actuellement en train de regarder la page).
//
// Volontairement sans jeton (contrairement à api/ping-presence.js) : ce
// prospect n'a pas de compte, seulement l'id qui lui a été attribué au
// moment de l'import et qui transite déjà en clair dans le lien de
// tracking envoyé par email (donc pas plus "secret" que ce que ce endpoint
// accepte). Il ne fait qu'horodater un timestamp de présence sur SA propre
// fiche — aucune lecture, aucune donnée sensible exposée ou modifiable.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'methode_non_autorisee' });
  }

  const { prospectId } = req.body || {};
  if (!prospectId || !UUID_RE.test(prospectId)) {
    return res.status(400).json({ success: false, error: 'prospectId manquant ou invalide' });
  }

  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?id=eq.${encodeURIComponent(prospectId)}`, {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ dernier_ping: new Date().toISOString() }),
    });
    return res.status(200).json({ success: true });
  } catch (e) {
    // Best-effort : un ping raté ne doit jamais casser la page du prospect.
    return res.status(200).json({ success: false });
  }
}
