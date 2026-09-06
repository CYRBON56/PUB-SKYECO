// /api/mes-leads.js
// Renvoie les demandes ("leads") reçues par l'artisan authentifié — toutes
// vitrines confondues quand le compte en possède plusieurs (même logique que
// api/mes-sites.js), ou uniquement le site courant pour un accès admin
// (admin_token, une seule vitrine par construction).
//
// Requête attendue : POST { draftId, token }
//
// Sécurité (06/09/2026) : mon-dashboard.html et dashboard-paysagiste.html
// lisaient jusqu'ici skyeco_pro_leads DIRECTEMENT depuis le navigateur avec
// la clé anonyme Supabase (publique), filtrée seulement côté client par
// draft_id — la table elle-même avait une policy RLS "SELECT" grande
// ouverte (qual: true) pour que ces pages fonctionnent. Comme un draft_id
// n'est PAS secret (il apparaît dans les URL finales des annonces Google
// Ads), n'importe qui pouvait interroger directement l'API REST Supabase et
// lire — ou avec la policy UPDATE, modifier — les demandes de N'IMPORTE
// QUELLE vitrine (nom, téléphone, email, adresse de chaque prospect), voire
// la table entière sans filtre du tout. Ce endpoint vérifie maintenant un
// vrai jeton de session AVANT toute lecture, avec la clé service_role côté
// serveur — les policies anon SELECT/UPDATE grandes ouvertes sur
// skyeco_pro_leads ont été retirées (voir la migration correspondante).
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

function roleDuToken(token) {
  try {
    const parties = Buffer.from(token, 'base64url').toString('utf8').split('.');
    return parties.length === 4 ? parties[1] : null;
  } catch (e) {
    return null;
  }
}

function emailDuTokenArtisan(token) {
  try {
    const [sujet] = Buffer.from(token, 'base64url').toString('utf8').split('.');
    return Buffer.from(sujet, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ success: false, error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    // Compte avec plusieurs vitrines (jeton "artisan" uniquement — un jeton
    // "admin" est toujours limité à UNE vitrine par construction, voir
    // api/dashboard-admin-token.js) : on regroupe les demandes de tous les
    // sites du même compte, comme le faisait mon-dashboard.html jusqu'ici.
    let idsRecherches = [draftId];
    let sites = [{ id: draftId }];
    if (roleDuToken(token) === 'artisan') {
      const email = emailDuTokenArtisan(token);
      if (email) {
        const sitesResp = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?email=ilike.${encodeURIComponent(email)}&archive=not.is.true&select=id,entreprise`,
          { headers: supaHeaders }
        );
        if (sitesResp.ok) {
          const sitesData = await sitesResp.json();
          if (Array.isArray(sitesData) && sitesData.length) {
            sites = sitesData;
            idsRecherches = sitesData.map(s => s.id);
          }
        }
      }
    }

    const filtreIds = idsRecherches.map(id => `"${id}"`).join(',');
    const leadsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?draft_id=in.(${filtreIds})&select=*&order=created_at.desc`,
      { headers: supaHeaders }
    );
    if (!leadsResp.ok) throw new Error('Lecture Supabase impossible : ' + (await leadsResp.text()));
    const leads = await leadsResp.json();

    return res.status(200).json({ success: true, leads, sites });
  } catch (err) {
    console.error('Erreur mes-leads :', err);
    return res.status(500).json({ success: false, error: 'Impossible de charger les demandes pour le moment.' });
  }
}
