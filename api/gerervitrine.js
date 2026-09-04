// /api/gerer-vitrine.js
// Permet à un artisan DÉJÀ CONNECTÉ (même jeton de session que
// creer-vitrine-supplementaire.js/mes-sites.js) d'archiver, désarchiver ou
// supprimer définitivement UNE de ses propres vitrines — demandé par
// Cyrille le 04/09 ("y a-t-il un bouton pour archiver et supprimer une
// vitrine"), qui n'existait jusqu'ici que côté admin interne
// (mes-artisans.html, pour suivre SES artisans clients, pas pour qu'un
// artisan gère SES PROPRES vitrines).
//
// Trois actions :
//   'archiver'   — pose le drapeau `archive` (réversible, ne supprime rien,
//                  même logique que mes-artisans.html). La vitrine disparaît
//                  du sélecteur/des tuiles par défaut (voir mes-sites.js).
//   'desarchiver'— retire ce drapeau.
//   'supprimer'  — suppression DÉFINITIVE de la ligne. Refusée si la vitrine
//                  a le moindre signe d'activité réelle (déjà payée, ou
//                  campagne Google Ads créée, ou au moins un lead reçu) —
//                  dans ce cas, on renvoie une erreur invitant à archiver à
//                  la place. Seul un brouillon jamais allé plus loin peut
//                  être supprimé.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

function decoderToken(token) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return null;
    const [emailB64, role, expStr, sig] = parties;
    if (role !== 'artisan') return null;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return null;

    const payload = `${emailB64}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return null;

    return Buffer.from(emailB64, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
}

const ACTIONS_VALIDES = ['archiver', 'desarchiver', 'supprimer'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token, action } = req.body || {};
  if (!draftId || !token || !ACTIONS_VALIDES.includes(action)) {
    return res.status(400).json({ success: false, error: 'Paramètres manquants ou invalides.' });
  }

  const email = decoderToken(token);
  if (!email) {
    return res.status(401).json({ success: false, error: 'Session invalide.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // La vitrine DOIT appartenir au même compte (email du jeton) — jamais
    // confiance au draftId seul, même vérification que
    // creer-vitrine-supplementaire.js.
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=id,email,entreprise,tarif_actif,google_ads_campaign_resource,status`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];
    if (!draft || !draft.email || draft.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Vitrine introuvable pour ce compte.' });
    }

    if (action === 'archiver' || action === 'desarchiver') {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ archive: action === 'archiver' }),
      });
      return res.status(200).json({ success: true, archive: action === 'archiver' });
    }

    // action === 'supprimer' — vérifie l'absence de toute trace d'activité
    // réelle avant d'autoriser une suppression définitive.
    if (draft.tarif_actif || draft.google_ads_campaign_resource) {
      return res.status(400).json({
        success: false,
        error: 'Cette vitrine a déjà été payée ou a une campagne Google Ads — elle ne peut pas être supprimée définitivement. Archivez-la plutôt.',
      });
    }
    const leadsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?draft_id=eq.${draftId}&select=id&limit=1`,
      { headers: supaHeaders }
    );
    const leadsRows = await leadsResp.json();
    if (Array.isArray(leadsRows) && leadsRows.length) {
      return res.status(400).json({
        success: false,
        error: 'Cette vitrine a déjà reçu des demandes de devis — elle ne peut pas être supprimée définitivement. Archivez-la plutôt.',
      });
    }

    const deleteResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'DELETE',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
    });
    if (!deleteResp.ok) throw new Error('Échec de la suppression.');

    return res.status(200).json({ success: true, supprime: true });
  } catch (err) {
    console.error('Erreur gerer-vitrine :', err);
    return res.status(500).json({ success: false, error: 'Impossible de traiter cette demande pour le moment.' });
  }
}
