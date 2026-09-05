// api/statut-appel-video.js
//
// POST /api/statut-appel-video   body: { draftId, token }
//
// Sondé toutes les 10s par mon-dashboard.html (onglet "Appel vidéo", côté
// artisan) pour savoir si Cyrille vient de démarrer un appel vidéo pour ce
// draftId précis (api/demarrer-appel-video.js met appel_statut='en_cours').
// Renvoie le lien Jitsi à rejoindre si c'est le cas. Même vérification de
// jeton que api/mes-rdv.js / api/ping-presence.js.
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
    // Fenêtre d'1h : un appel démarré depuis plus longtemps est considéré
    // caduc (évite d'afficher indéfiniment la bannière "Cyrille vous
    // appelle" si personne n'a pensé à clôturer l'appel côté admin).
    const ilYA1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('rendez_vous_artisans')
      .select('id, room_name, appel_demarre_le')
      .eq('draft_id_demandeur', draftId)
      .eq('type_rdv', 'appel_video_artisan')
      .eq('appel_statut', 'en_cours')
      .gte('appel_demarre_le', ilYA1h)
      .order('appel_demarre_le', { ascending: false })
      .limit(1);

    if (error || !data || !data.length) {
      return res.status(200).json({ enCours: false });
    }

    const appel = data[0];
    return res.status(200).json({
      enCours: true,
      rdvId: appel.id,
      roomUrl: `https://meet.jit.si/${appel.room_name}`,
    });
  } catch (e) {
    return res.status(200).json({ enCours: false });
  }
}
