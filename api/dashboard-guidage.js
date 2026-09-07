// api/dashboard-guidage.js
//
// POST /api/dashboard-guidage   body: { draftId, token, action, ... }
//
// "Session guidée" (demande de Cyrille, 07/09/2026) : quand il ouvre le
// dashboard d'un artisan avec le bouton "🎥 Prise en main" de mes-artisans.html
// (mon-dashboard.html?...&guidage=1), sa position de curseur et la section
// qu'il consulte sont poussées ici toutes les ~700ms ; si l'artisan a son
// propre dashboard ouvert au même moment, il sonde le même état et voit un
// curseur "Cyrille" en direct + son écran suit automatiquement la section
// consultée (voir mon-dashboard.html, initGuidage / initSuiviGuidage).
//
// Consentement obligatoire (ajouté le 07/09, même jour) : l'artisan doit
// d'abord autoriser la session avant que quoi que ce soit ne s'affiche chez
// lui. "demarrer" remet toujours autorise=null (nouvelle demande) ; l'état
// renvoyé à l'artisan distingue "en attente de réponse" / "autorisé" /
// "refusé" ; seul le rôle artisan peut répondre (action "repondre").
//
// Pas de WebSocket/Realtime ici : simple sondage, comme api/ping-presence.js
// et api/statut-appel-video.js déjà en place dans ce projet — cohérent avec
// le reste, largement suffisant pour ce besoin (pas un outil de jeu vidéo).
//
//   action = 'demarrer' -> { hash } — réservé au rôle admin — (re)démarre une
//                          demande, remet autorise=null
//   action = 'maj'      -> { hash, curseurX, curseurY, clic:boolean } — réservé au rôle admin
//   action = 'arreter'  -> {} — réservé au rôle admin
//   action = 'repondre' -> { autorise:boolean } — réservé au rôle artisan
//   action = 'etat'     -> renvoie l'état courant si actif et récent (< 8s) :
//                          { actif:true, enAttenteAutorisation:true } si pas
//                          encore répondu, { actif:true, autorise:false } si
//                          refusé (rien à afficher), ou { actif:true,
//                          autorise:true, hash, curseurX, ... } si autorisé.
//                          { actif:false } sinon. Les deux rôles peuvent lire.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// DASHBOARD_SESSION_SECRET

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FENETRE_FRAICHEUR_MS = 8000;

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

  const { draftId, token, action, hash, curseurX, curseurY, clic, autorise } = req.body || {};
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
        .from('skyeco_pro_dashboard_guidage')
        .select('actif, autorise, hash_cible, curseur_x, curseur_y, dernier_clic_x, dernier_clic_y, dernier_clic_le, maj_le')
        .eq('draft_id', draftId)
        .maybeSingle();
      if (error) throw error;
      if (!data || !data.actif || (Date.now() - new Date(data.maj_le).getTime()) > FENETRE_FRAICHEUR_MS) {
        return res.status(200).json({ success: true, actif: false });
      }
      if (data.autorise === null) {
        return res.status(200).json({ success: true, actif: true, enAttenteAutorisation: true });
      }
      if (data.autorise === false) {
        return res.status(200).json({ success: true, actif: true, autorise: false });
      }
      const clicRecent = data.dernier_clic_le && (Date.now() - new Date(data.dernier_clic_le).getTime()) < 1200;
      return res.status(200).json({
        success: true, actif: true, autorise: true, hash: data.hash_cible,
        curseurX: data.curseur_x, curseurY: data.curseur_y,
        clic: clicRecent, clicX: data.dernier_clic_x, clicY: data.dernier_clic_y,
      });
    }

    if (action === 'repondre') {
      if (role !== 'artisan') {
        return res.status(403).json({ success: false, error: 'reserve_artisan' });
      }
      const { error } = await supabase
        .from('skyeco_pro_dashboard_guidage')
        .update({ autorise: !!autorise })
        .eq('draft_id', draftId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (role !== 'admin') {
      return res.status(403).json({ success: false, error: 'reserve_admin' });
    }

    if (action === 'demarrer') {
      const { error } = await supabase
        .from('skyeco_pro_dashboard_guidage')
        .upsert({ draft_id: draftId, actif: true, autorise: null, hash_cible: hash || null, maj_le: new Date().toISOString() });
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'maj') {
      const patch = {
        draft_id: draftId, actif: true, hash_cible: hash || null,
        curseur_x: typeof curseurX === 'number' ? curseurX : null,
        curseur_y: typeof curseurY === 'number' ? curseurY : null,
        maj_le: new Date().toISOString(),
      };
      if (clic) {
        patch.dernier_clic_x = patch.curseur_x;
        patch.dernier_clic_y = patch.curseur_y;
        patch.dernier_clic_le = patch.maj_le;
      }
      const { error } = await supabase.from('skyeco_pro_dashboard_guidage').upsert(patch);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'arreter') {
      const { error } = await supabase
        .from('skyeco_pro_dashboard_guidage')
        .upsert({ draft_id: draftId, actif: false, maj_le: new Date().toISOString() });
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'action inconnue' });
  } catch (err) {
    console.error('Erreur dashboard-guidage :', err);
    return res.status(500).json({ success: false, error: 'Impossible de traiter la demande pour le moment.' });
  }
}
