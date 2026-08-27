// api/prospects-delete.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Méthode non autorisée." });
  }

  const { ids, draft_id } = req.body || {};
  if (!draft_id) return res.status(400).json({ success: false, error: "Identifiant de site manquant." });
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: "Aucun prospect sélectionné." });
  }

  try {
    const idsFilter = ids.map((id) => `"${id}"`).join(",");
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?id=in.(${idsFilter})&draft_id=eq.${draft_id}`,
      {
        method: "DELETE",
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "return=minimal",
        },
      }
    );
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail);
    }
    return res.status(200).json({ success: true, deleted: ids.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Suppression impossible : " + err.message });
  }
}
