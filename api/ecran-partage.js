// api/ecran-partage.js
//
// POST /api/ecran-partage   body: { draftId, token, action, ... }
//
// Partage d'écran RÉEL en direct, en lecture seule (pas de contrôle à
// distance) — demande de Cyrille du 07/09/2026 après clarification :
// il voulait voir l'écran de l'artisan, pas un simple curseur qui le suit
// (voir la version précédente, api/dashboard-guidage.js, désormais inutilisée).
//
// WebRTC entre le navigateur de l'artisan (qui partage, via
// getDisplayMedia) et celui de Cyrille (qui regarde). Signalisation
// "non-trickle" : chaque camp attend la fin de sa collecte ICE avant
// d'écrire un SDP complet ici (pas de flux de candidats à gérer), l'autre
// camp le récupère au sondage suivant (~1.2-1.5s) — même principe que
// api/ping-presence.js / api/statut-appel-video.js, juste avec un peu plus
// d'aller-retours. Serveur STUN public uniquement (pas de TURN) : suffisant
// dans la grande majorité des cas.
//
//   action = 'demander' -> {} — réservé au rôle admin, remet statut='demande'
//   action = 'repondre' -> { autorise:boolean } — réservé au rôle artisan
//   action = 'offre'    -> { sdp } — réservé au rôle artisan (a le flux vidéo)
//   action = 'reponse'  -> { sdp } — réservé au rôle admin
//   action = 'terminer' -> {} — les deux rôles peuvent couper la session
//   action = 'etat'     -> renvoie l'état courant (statut, offreSdp,
//                          reponseSdp) — les deux rôles peuvent lire
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
    if (parties.length !== 4) return null;
    const [sujet, role, expStr, sig] = parties;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return null;

    const payload = `${sujet}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return null;

    if (role === 'admin') {
      return sujet === draftIdAttendu ? 'admin' : null;
    }
    if (role === 'artisan') {
      let email;
      try { email = Buffer.from(sujet, 'base64url').toString('utf8'); } catch (e) { return null; }
      if (!email) return null;
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftIdAttendu}&select=email`,
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const rows = await resp.json();
      const draft = rows[0];
      return (draft && draft.email && draft.email.toLowerCase() === email.toLowerCase()) ? 'artisan' : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'methode_non_autorisee' });
  }

  const { draftId, token, action, autorise, sdp } = req.body || {};
  if (!draftId || !token || !action) {
    return res.status(401).json({ success: false, error: 'non_authentifie' });
  }
  const role = await verifierToken(token, draftId);
  if (!role) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
  }

  try {
    if (action === 'etat') {
      const { data, error } = await supabase
        .from('skyeco_pro_ecran_partage')
        .select('statut, offre_sdp, reponse_sdp')
        .eq('draft_id', draftId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(200).json({ success: true, statut: 'inactif' });
      return res.status(200).json({ success: true, statut: data.statut, offreSdp: data.offre_sdp, reponseSdp: data.reponse_sdp });
    }

    if (action === 'terminer') {
      const { error } = await supabase
        .from('skyeco_pro_ecran_partage')
        .upsert({ draft_id: draftId, statut: 'termine', offre_sdp: null, reponse_sdp: null, maj_le: new Date().toISOString() });
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'repondre') {
      if (role !== 'artisan') return res.status(403).json({ success: false, error: 'reserve_artisan' });
      const { error } = await supabase
        .from('skyeco_pro_ecran_partage')
        .update({ statut: autorise ? 'autorise' : 'refuse', maj_le: new Date().toISOString() })
        .eq('draft_id', draftId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'offre') {
      if (role !== 'artisan') return res.status(403).json({ success: false, error: 'reserve_artisan' });
      if (!sdp) return res.status(400).json({ success: false, error: 'sdp manquant' });
      const { error } = await supabase
        .from('skyeco_pro_ecran_partage')
        .update({ statut: 'offre_prete', offre_sdp: sdp, maj_le: new Date().toISOString() })
        .eq('draft_id', draftId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (role !== 'admin') {
      return res.status(403).json({ success: false, error: 'reserve_admin' });
    }

    if (action === 'demander') {
      const { error } = await supabase
        .from('skyeco_pro_ecran_partage')
        .upsert({ draft_id: draftId, statut: 'demande', offre_sdp: null, reponse_sdp: null, maj_le: new Date().toISOString() });
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'reponse') {
      if (!sdp) return res.status(400).json({ success: false, error: 'sdp manquant' });
      const { error } = await supabase
        .from('skyeco_pro_ecran_partage')
        .update({ statut: 'connecte', reponse_sdp: sdp, maj_le: new Date().toISOString() })
        .eq('draft_id', draftId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'action inconnue' });
  } catch (err) {
    console.error('Erreur ecran-partage :', err);
    return res.status(500).json({ success: false, error: 'Impossible de traiter la demande pour le moment.' });
  }
}
