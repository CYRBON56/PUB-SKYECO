// api/ping-presence.js
//
// POST /api/ping-presence   body: { draftId, token }
//
// Ping léger envoyé par mon-dashboard.html toutes les 30s tant que l'onglet
// est visible, pour horodater "dashboard_dernier_ping" sur
// skyeco_pro_vitrine_drafts — utilisé par mes-artisans.html pour afficher un
// statut en ligne/hors ligne (05/09, voir architecture "appel vidéo" dans le
// doc technique du projet). Accepte les deux rôles de jeton (admin ou
// artisan), même vérification que api/mes-rdv.js.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// DASHBOARD_SESSION_SECRET

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

    if (role === 'admin') {
      return sujet === draftIdAttendu;
    }
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
    return res.status(405).json({ error: 'methode_non_autorisee' });
  }

  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ error: 'session_invalide' });
  }

  try {
    await supabase
      .from('skyeco_pro_vitrine_drafts')
      .update({ dashboard_dernier_ping: new Date().toISOString() })
      .eq('id', draftId);
    return res.status(200).json({ ok: true });
  } catch (e) {
    // Best-effort : un ping raté ne doit jamais casser le dashboard.
    return res.status(200).json({ ok: false });
  }
}
