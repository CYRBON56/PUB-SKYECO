// api/ouverture.js
// Pixel de suivi d'ouverture d'email — servi sur /o?p=<clic_token> (voir
// vercel.json). Le même jeton peut appartenir à deux tables différentes :
// prospects_vitrine (un artisan qui prospecte SES clients) ou
// prospects_paysagiste (Skyeco Pro qui prospecte des artisans pour les
// faire s'abonner — 04/09) — on cherche dans les deux, jamais les deux à la
// fois (un jeton n'existe que dans une seule table).
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7", "base64");

// 28/09/2026 : Gmail (proxy d'images) et les antivirus d'entreprise chargent
// le pixel quelques secondes après la réception, sans aucun humain. Pour
// prospects_paysagiste, une ouverture moins de 60 s après l'envoi est donc
// comptée à part (nb_ouvertures_auto) et ne passe PAS email_ouvert à true.
const DELAI_OUVERTURE_AUTO_MS = 60 * 1000;

async function marquerOuverture(table, headers, p) {
  const avecDate = table === 'prospects_paysagiste';
  const colonnes = avecDate ? 'id,nb_ouvertures,nb_ouvertures_auto,date_envoi_email' : 'id,nb_ouvertures';
  const lecture = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?clic_token=eq.${encodeURIComponent(p)}&select=${colonnes}`, { headers });
  const rows = lecture.ok ? await lecture.json() : [];
  const prospect = rows && rows[0];
  if (!prospect) return false;

  let corps = { email_ouvert: true, date_ouverture: new Date().toISOString(), nb_ouvertures: (prospect.nb_ouvertures || 0) + 1 };
  if (avecDate && prospect.date_envoi_email && (Date.now() - new Date(prospect.date_envoi_email).getTime()) < DELAI_OUVERTURE_AUTO_MS) {
    corps = { nb_ouvertures_auto: (prospect.nb_ouvertures_auto || 0) + 1 };
  }
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(prospect.id)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(corps),
  });
  return true;
}

export default async function handler(req, res) {
  const { p } = req.query || {};

  function repondrePixel() {
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.status(200).send(PIXEL_GIF);
  }

  if (!p) return repondrePixel();

  try {
    const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
    const trouve = await marquerOuverture('prospects_vitrine', headers, p);
    if (!trouve) await marquerOuverture('prospects_paysagiste', headers, p);
  } catch (err) {
    console.error("ouverture tracking error:", err);
  }

  return repondrePixel();
}
