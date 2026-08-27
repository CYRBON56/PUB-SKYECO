// api/ouverture.js
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7", "base64");

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
    const lecture = await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?clic_token=eq.${encodeURIComponent(p)}&select=id,nb_ouvertures`, { headers });
    const rows = lecture.ok ? await lecture.json() : [];
    const prospect = rows && rows[0];
    if (prospect) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?id=eq.${encodeURIComponent(prospect.id)}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ email_ouvert: true, date_ouverture: new Date().toISOString(), nb_ouvertures: (prospect.nb_ouvertures || 0) + 1 }),
      });
    }
  } catch (err) {
    console.error("ouverture tracking error:", err);
  }

  return repondrePixel();
}
