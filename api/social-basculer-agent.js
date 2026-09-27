// /api/social-basculer-agent.js
// Met en pause ou réactive la publication automatique de l'agent IA réseaux
// sociaux pour un artisan (27/09/2026), sans toucher aux connexions déjà
// établies (facebook_page_id, tiktok_open_id, etc. restent en base).
//
// POST { draftId, token, actif }
//
// Variables d'environnement requises :
//   DASHBOARD_SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from 'crypto';

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
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  const { draftId, token, actif } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ success: false, error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
  }

  try {
    const supaHeaders = {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    };
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?draft_id=eq.${draftId}`, {
      method: 'PATCH',
      headers: supaHeaders,
      body: JSON.stringify({ auto_publication_active: !!actif }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur social-basculer-agent :', err);
    return res.status(500).json({ success: false, error: "Impossible de mettre à jour l'agent pour le moment." });
  }
}
