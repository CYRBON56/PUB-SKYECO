// api/prospects-import.js
// Importe (ou met à jour) une liste de prospects pour un mini-site précis.
//
// Requête attendue : POST
//   Body: { draft_id, token, prospects: [{ nom, ville, departement, telephone, telephone_e164, adresse, email }, ...] }
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

// Sécurité (06/09/2026) : voir api/bloquer-creneau.js — ce endpoint permettait
// d'injecter des prospects dans n'importe quel mini-site sur simple
// présentation d'un draft_id, sans aucune vérification.
async function verifierToken(token, draftIdAttendu) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return false;
    const [sujet, role, expStr, sig] = parties;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return false;

    const payload = `${sujet}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return false;

    if (role === 'admin') return sujet === draftIdAttendu;
    if (role === 'artisan') {
      let email;
      try { email = Buffer.from(sujet, 'base64url').toString('utf8'); } catch (e) { return false; }
      if (!email) return false;
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftIdAttendu}&select=email`,
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const rows = await resp.json();
      const draft = rows[0];
      return !!(draft && draft.email && draft.email.toLowerCase() === email.toLowerCase());
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function upsert(rows, conflictColumn, draftId) {
  if (rows.length === 0) return 0;
  const rowsAvecDraft = rows.map((r) => ({ ...r, draft_id: draftId }));
  const resp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?on_conflict=draft_id,${conflictColumn}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rowsAvecDraft),
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

  const { draft_id, token, prospects } = req.body || {};
  if (!draft_id || !token) {
    return res.status(401).json({ success: false, error: "non_authentifie" });
  }
  if (!(await verifierToken(token, draft_id))) {
    return res.status(401).json({ success: false, error: "session_invalide" });
  }
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
    if (row.telephone_e164) parPhone.set(row.telephone_e164, row);
    else if (row.email) parEmail.set(row.email, row);
    else ignores++;
  });

  const lignesAvecMobile = Array.from(parPhone.values());
  const lignesSansMobile = Array.from(parEmail.values());

  if (lignesAvecMobile.length === 0 && lignesSansMobile.length === 0) {
    return res.status(400).json({ success: false, error: "Aucun mobile ni email valide dans le fichier." });
  }

  try {
    const nbAvecMobile = await upsert(lignesAvecMobile, "telephone_e164", draft_id);
    const nbSansMobile = await upsert(lignesSansMobile, "email", draft_id);

    return res.status(200).json({
      success: true,
      imported: nbAvecMobile + nbSansMobile,
      avecMobile: nbAvecMobile,
      emailSeul: nbSansMobile,
      ignores,
    });
  } catch (err) {
    console.error("prospects-import error:", err);
    return res.status(500).json({ success: false, error: "Import impossible : " + err.message });
  }
}
