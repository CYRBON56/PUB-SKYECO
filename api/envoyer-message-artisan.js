// api/messages-artisan.js
//
// POST /api/messages-artisan   body: { draftId, token, action, ... }
//   action = 'liste'       -> { success, messages: [{ id, contenu, lu, cree_le }] } (10 derniers)
//   action = 'marquer_lu'  -> { messageId } -> marque ce message comme lu
//
// Sondé par mon-dashboard.html pour afficher les messages que Cyrille envoie
// depuis "mes artisans" (api/envoyer-message-artisan.js) quand un artisan a
// un problème — SMS immédiat + trace ici au cas où le SMS soit raté. Même
// vérification de jeton que api/ping-presence.js / api/statut-appel-video.js
// (accepte les deux rôles, admin ou artisan).
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
    return res.status(405).json({ success: false, error: 'methode_non_autorisee' });
  }

  const { draftId, token, action, messageId } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ success: false, error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
  }

  try {
    if (action === 'liste') {
      const { data, error } = await supabase
        .from('skyeco_pro_messages_admin')
        .select('id, contenu, lu, cree_le')
        .eq('draft_id', draftId)
        .order('cree_le', { ascending: false })
        .limit(10);
      if (error) throw error;
      return res.status(200).json({ success: true, messages: data || [] });
    }

    if (action === 'marquer_lu') {
      if (!messageId) return res.status(400).json({ success: false, error: 'messageId manquant' });
      const { error } = await supabase
        .from('skyeco_pro_messages_admin')
        .update({ lu: true, lu_le: new Date().toISOString() })
        .eq('id', messageId)
        .eq('draft_id', draftId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'action inconnue' });
  } catch (err) {
    console.error('Erreur messages-artisan :', err);
    return res.status(500).json({ success: false, error: "Impossible de charger les messages pour le moment." });
  }
}
