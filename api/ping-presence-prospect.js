// api/ping-presence-prospect.js
//
// POST /api/ping-presence-prospect   body: { prospectId, page? }
//
// Ping léger envoyé toutes les 30s (tant que l'onglet est visible) par les
// pages du tunnel d'inscription atteignables depuis le lien de tracking de
// prospection (/l?p=... -> voir api/lien.js, qui ajoute ?pp=<id> à la
// destination, propagé ensuite via sessionStorage) :
//   - skyeco-pro-formulaire-creation.html (page d'inscription)
//   - mon-dashboard-demo.html (démo ouverte depuis "Faire un essai gratuit")
//
// Deux effets par ping :
//   1) Horodate prospects_paysagiste.dernier_ping — utilisé par
//      prospects-paysagiste.html pour le bandeau "en ce moment sur le site".
//   2) Si "page" est fourni, journalise la visite dans
//      prospects_paysagiste_visites : prolonge la ligne en cours (même page,
//      dernier ping il y a moins de 5 min -> on mémorise juste le temps
//      passé) ou en ouvre une nouvelle (changement de page, ou retour après
//      plus de 5 min d'absence) — utilisé par prospects-paysagiste.html pour
//      l'historique "pages visitées / temps resté" par artisan démarché
//      (18/09/2026 — demande de Cyrille).
//
// Volontairement sans jeton (contrairement à api/ping-presence.js) : ce
// prospect n'a pas de compte, seulement l'id qui lui a été attribué au
// moment de l'import et qui transite déjà en clair dans le lien de
// tracking envoyé par email (donc pas plus "secret" que ce que ce endpoint
// accepte). Il ne fait qu'horodater sa propre fiche et son propre historique
// de visite — aucune lecture, aucune donnée sensible exposée ou modifiable.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPRISE_VISITE_MS = 5 * 60 * 1000; // au-delà, on considère que c'est une nouvelle visite

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'methode_non_autorisee' });
  }

  const { prospectId, page } = req.body || {};
  if (!prospectId || !UUID_RE.test(prospectId)) {
    return res.status(400).json({ success: false, error: 'prospectId manquant ou invalide' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  const maintenant = new Date();

  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?id=eq.${encodeURIComponent(prospectId)}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ dernier_ping: maintenant.toISOString() }),
    });

    // "page" : chemin de la page (ex. "/skyeco-pro-formulaire-creation.html"),
    // tronqué par précaution — jamais censé dépasser une centaine de
    // caractères, une valeur aberrante n'a pas à faire échouer le ping.
    const pageNettoyee = typeof page === 'string' ? page.slice(0, 200) : null;
    if (pageNettoyee) {
      const lecture = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste_visites?prospect_id=eq.${encodeURIComponent(prospectId)}&select=id,page,last_seen_at&order=entered_at.desc&limit=1`,
        { headers: supaHeaders }
      );
      const dernieresVisites = lecture.ok ? await lecture.json() : [];
      const derniere = dernieresVisites && dernieresVisites[0];
      const reprend = derniere && derniere.page === pageNettoyee
        && (maintenant.getTime() - new Date(derniere.last_seen_at).getTime()) < REPRISE_VISITE_MS;

      if (reprend) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste_visites?id=eq.${encodeURIComponent(derniere.id)}`, {
          method: 'PATCH',
          headers: { ...supaHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ last_seen_at: maintenant.toISOString() }),
        });
      } else {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste_visites`, {
          method: 'POST',
          headers: { ...supaHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ prospect_id: prospectId, page: pageNettoyee, entered_at: maintenant.toISOString(), last_seen_at: maintenant.toISOString() }),
        });
      }
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    // Best-effort : un ping raté ne doit jamais casser la page du prospect.
    return res.status(200).json({ success: false });
  }
}
