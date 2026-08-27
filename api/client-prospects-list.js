// api/client-prospects-list.js
// Retourne la liste des prospects de L'ENTREPRISE CONNECTÉE uniquement
// (jamais ceux d'un autre client).
//
// Requête attendue : GET, Headers: Authorization: Bearer <token Supabase Auth>

import { authentifierEntreprise } from "./_lib/auth-entreprise.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Méthode non autorisée." });
  }

  const { entreprise, error, status } = await authentifierEntreprise(req);
  if (error) return res.status(status).json({ success: false, error });

  try {
    const PAGE_SIZE = 1000;
    let offset = 0;
    let toutesLesLignes = [];
    let total = null;

    while (true) {
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/prospects_clients?select=*&entreprise_id=eq.${entreprise.id}&order=created_at.desc`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: "count=exact",
            Range: `${offset}-${offset + PAGE_SIZE - 1}`,
          },
        }
      );

      if (!resp.ok) {
        const detail = await resp.text();
        console.error("client-prospects-list supabase error:", detail);
        return res.status(500).json({ success: false, error: "Chargement impossible (Supabase)." });
      }

      const page = await resp.json();
      toutesLesLignes = toutesLesLignes.concat(page);

      if (total === null) {
        const contentRange = resp.headers.get("content-range") || "";
        const match = contentRange.match(/\/(\d+)$/);
        total = match ? parseInt(match[1], 10) : toutesLesLignes.length;
      }

      offset += PAGE_SIZE;
      if (toutesLesLignes.length >= total || page.length === 0) break;
    }

    return res.status(200).json({ success: true, prospects: toutesLesLignes });
  } catch (err) {
    console.error("client-prospects-list error:", err);
    return res.status(500).json({ success: false, error: "Chargement impossible pour le moment." });
  }
}
