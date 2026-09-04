// api/ouverture.js
// Pixel de suivi d'ouverture d'email — servi sur /o?p=<clic_token> (voir
// vercel.json). Le même jeton peut appartenir à deux tables différentes :
// prospects_vitrine (un artisan qui prospecte SES clients) ou
// prospects_paysagiste (Skyeco Pro qui prospecte des artisans pour les
// faire s'abonner — 04/09) — on cherche dans les deux, jamais les deux à la
// fois (un jeton n'existe que dans une seule table).
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7", "base64");

async function marquerOuverture(table, headers, p) {
  const lecture = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?clic_token=eq.${encodeURIComponent(p)}&select=id,nb_ouvertures`, { headers });
  const rows = lecture.ok ? await lecture.json() : [];
  const prospect = rows && rows[0];
  if (!prospect) return false;
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(prospect.id)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ email_ouvert: true, date_ouverture: new Date().toISOString(), nb_ouvertures: (prospect.nb_ouvertures || 0) + 1 }),
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
