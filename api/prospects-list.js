// api/prospects-list.js
// Retourne les prospects appartenant à un mini-site (draft_id) précis.
//
// Requête attendue : GET  ?draft_id=<uuid>&token=<jeton de session>
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

// Sécurité (06/09/2026) : voir api/bloquer-creneau.js — ce endpoint révélait
// la liste complète des prospects (nom, tél, email, adresse) d'un mini-site
// sur simple présentation d'un draft_id, sans aucune vérification.
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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Méthode non autorisée." });
  }

  const { draft_id, token } = req.query || {};
  if (!draft_id || !token) {
    return res.status(401).json({ success: false, error: "non_authentifie" });
  }
  if (!(await verifierToken(token, draft_id))) {
    return res.status(401).json({ success: false, error: "session_invalide" });
  }

  try {
    const PAGE_SIZE = 1000;
    let offset = 0;
    let toutesLesLignes = [];
    let total = null;

    while (true) {
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?select=*&draft_id=eq.${draft_id}&order=created_at.desc`,
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
        console.error("prospects-list supabase error:", detail);
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
    console.error("prospects-list error:", err);
    return res.status(500).json({ success: false, error: "Chargement impossible pour le moment." });
  }
}
