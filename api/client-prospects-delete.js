// api/client-prospects-delete.js
// Supprime des prospects appartenant à L'ENTREPRISE CONNECTÉE uniquement.
//
// Requête attendue : POST, Headers: Authorization: Bearer <token Supabase Auth>
//   Body: { ids: ["uuid1", "uuid2", ...] }

import { authentifierEntreprise } from "./_lib/auth-entreprise.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Méthode non autorisée." });
  }

  const { entreprise, error, status } = await authentifierEntreprise(req);
  if (error) return res.status(status).json({ success: false, error });

  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: "Aucun prospect sélectionné." });
  }

  try {
    const idsFilter = ids.map((id) => `"${id}"`).join(",");
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/prospects_clients?id=in.(${idsFilter})&entreprise_id=eq.${entreprise.id}`,
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
    console.error("client-prospects-delete error:", err);
    return res.status(500).json({ success: false, error: "Suppression impossible : " + err.message });
  }
}
