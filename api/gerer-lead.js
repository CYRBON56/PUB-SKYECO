// /api/gerer-lead.js
// Permet à un artisan authentifié (jeton admin limité à SON draftId, ou
// jeton artisan valable sur tous ses sites — même vérification que
// api/mes-leads.js et api/lead-statut.js) d'archiver, désarchiver ou
// supprimer définitivement UNE de ses demandes clients ("leads") — demandé
// par Cyrille le 08/09/2026 ("il faut pouvoir archiver puis supprimer les
// clients du dashboard"), sur le même modèle que api/gerer-vitrine.js
// (archiver/désarchiver/supprimer une vitrine).
//
// Trois actions :
//   'archiver'   — pose le drapeau `archive` (réversible, ne supprime rien).
//                  Le client disparaît de la liste "Demandes d'estimation"
//                  par défaut, mais reste consultable dans le panneau
//                  "🗑️ Clients archivés".
//   'desarchiver'— retire ce drapeau.
//   'supprimer'  — suppression DÉFINITIVE de la ligne (coordonnées, photos,
//                  historique de devis). Refusée si le client n'est pas
//                  déjà archivé, pour éviter une suppression accidentelle en
//                  un clic — même logique "archiver puis supprimer" que
//                  demandée.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

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

const ACTIONS_VALIDES = ['archiver', 'desarchiver', 'supprimer'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { leadId, token, action } = req.body || {};
  if (!leadId || !token || !ACTIONS_VALIDES.includes(action)) {
    return res.status(400).json({ success: false, error: 'Paramètres manquants ou invalides.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const leadResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&select=id,draft_id,archive`,
      { headers: supaHeaders }
    );
    if (!leadResp.ok) throw new Error('Lecture Supabase impossible : ' + (await leadResp.text()));
    const leadRows = await leadResp.json();
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ success: false, error: 'introuvable' });

    if (!(await verifierToken(token, lead.draft_id))) {
      return res.status(401).json({ success: false, error: 'session_invalide' });
    }

    if (action === 'archiver' || action === 'desarchiver') {
      const patch = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ archive: action === 'archiver', updated_at: new Date().toISOString() }),
      });
      if (!patch.ok) throw new Error('Écriture Supabase impossible : ' + (await patch.text()));
      return res.status(200).json({ success: true, archive: action === 'archiver' });
    }

    // action === 'supprimer' — n'autorise la suppression définitive que
    // depuis l'état archivé (voir commentaire en tête de fichier).
    if (!lead.archive) {
      return res.status(400).json({
        success: false,
        error: 'Ce client doit d\'abord être archivé avant de pouvoir être supprimé définitivement.',
      });
    }

    const deleteResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`, {
      method: 'DELETE',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
    });
    if (!deleteResp.ok) throw new Error('Échec de la suppression.');

    return res.status(200).json({ success: true, supprime: true });
  } catch (err) {
    console.error('Erreur gerer-lead :', err);
    return res.status(500).json({ success: false, error: 'Impossible de traiter cette demande pour le moment.' });
  }
}
