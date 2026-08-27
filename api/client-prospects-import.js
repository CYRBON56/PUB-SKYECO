// api/client-prospects-import.js
// Importe (ou met à jour) une liste de prospects pour L'ENTREPRISE CONNECTÉE.
// Même logique que api/prospects-import.js, mais scopée par entreprise_id.
//
// Requête attendue : POST, Headers: Authorization: Bearer <token Supabase Auth>
//   Body: { prospects: [{ nom, ville, departement, telephone, telephone_e164, adresse, email }, ...] }

import { authentifierEntreprise } from "./_lib/auth-entreprise.js";

async function upsert(rows, conflictColumn, entrepriseId) {
  if (rows.length === 0) return 0;
  const rowsAvecEntreprise = rows.map((r) => ({ ...r, entreprise_id: entrepriseId }));
  const resp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/prospects_clients?on_conflict=entreprise_id,${conflictColumn}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rowsAvecEntreprise),
    }
  );
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Supabase (${conflictColumn}): ${detail}`);
  }
  return rows.length;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Méthode non autorisée." });
  }

  const { entreprise, error, status } = await authentifierEntreprise(req);
  if (error) return res.status(status).json({ success: false, error });

  const { prospects } = req.body || {};
  if (!Array.isArray(prospects) || prospects.length === 0) {
    return res.status(400).json({ success: false, error: "Liste de prospects manquante." });
  }

  const normalise = (p) => ({
    nom: p.nom || "",
    ville: p.ville || "",
    departement: p.departement || "",
    telephone: p.telephone || "",
    telephone_e164: p.telephone_e164 || null,
    adresse: p.adresse || "",
    email: p.email || null,
  });

  const parPhone = new Map();
  const parEmail = new Map();
  let ignores = 0;

  prospects.filter(Boolean).forEach((p) => {
    const row = normalise(p);
    if (row.telephone_e164) {
      parPhone.set(row.telephone_e164, row);
    } else if (row.email) {
      parEmail.set(row.email, row);
    } else {
      ignores++;
    }
  });

  const lignesAvecMobile = Array.from(parPhone.values());
  const lignesSansMobile = Array.from(parEmail.values());

  if (lignesAvecMobile.length === 0 && lignesSansMobile.length === 0) {
    return res.status(400).json({ success: false, error: "Aucun mobile ni email valide dans le fichier." });
  }

  try {
    const nbAvecMobile = await upsert(lignesAvecMobile, "telephone_e164", entreprise.id);
    const nbSansMobile = await upsert(lignesSansMobile, "email", entreprise.id);

    return res.status(200).json({
      success: true,
      imported: nbAvecMobile + nbSansMobile,
      avecMobile: nbAvecMobile,
      emailSeul: nbSansMobile,
      ignores,
    });
  } catch (err) {
    console.error("client-prospects-import error:", err);
    return res.status(500).json({ success: false, error: "Import impossible : " + err.message });
  }
}
