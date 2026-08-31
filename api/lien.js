// api/lien.js
// Lien de tracking court inséré dans les SMS/emails de prospection.
// Redirige vers apercu.html du site concerné après avoir enregistré le clic.

export default async function handler(req, res) {
  const { p } = req.query || {};
  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  let destination = "https://app.skyeco.fr/index.html";

  if (p) {
    try {
      const lecture = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?clic_token=eq.${encodeURIComponent(p)}&select=id,draft_id,nb_clics`,
        { headers: supaHeaders }
      );
      const rows = lecture.ok ? await lecture.json() : [];
      const prospect = rows && rows[0];

      if (prospect) {
        destination = `https://app.skyeco.fr/apercu.html?id=${prospect.draft_id}`;
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?id=eq.${encodeURIComponent(prospect.id)}`, {
          method: "PATCH",
          headers: { ...supaHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ lien_clique: true, clic_date: new Date().toISOString(), nb_clics: (prospect.nb_clics || 0) + 1 }),
        });
      }
    } catch (err) {
      console.error("lien tracking error:", err);
    }
  }

  res.writeHead(302, { Location: destination });
  return res.end();
}
