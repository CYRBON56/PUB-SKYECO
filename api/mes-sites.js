// /api/mes-sites.js
// Liste toutes les vitrines (sites) rattachées au même compte (email)
// qu'un jeton de session artisan valide — utilisé par le sélecteur de site
// dans mon-dashboard.html pour un artisan qui possède plusieurs vitrines
// (ex : plusieurs activités différentes).
//
// Par défaut, exclut les vitrines archivées (colonne `archive`, ajoutée pour
// mes-artisans.html) — passer inclureArchives:true dans le corps de la
// requête pour les récupérer aussi (utilisé par le panneau "Vitrines
// archivées" de mon-dashboard.html, 04/09). tarif_actif et
// google_ads_campaign_resource sont renvoyés pour que le tableau de bord
// sache si une vitrine peut être supprimée définitivement (jamais payée, pas
// de campagne créée) ou doit seulement être archivée.
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  const { token, inclureArchives } = req.body || {};
  if (!token) {
    return res.status(400).json({ success: false, error: 'token manquant' });
  }

  const email = decoderToken(token);
  if (!email) {
    return res.status(401).json({ success: false, error: 'Session invalide.' });
  }

  try {
    const filtreArchive = inclureArchives ? '' : '&archive=not.is.true';
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?email=ilike.${encodeURIComponent(email)}&dashboard_password_hash=not.is.null${filtreArchive}&order=dashboard_compte_cree_le.asc&select=id,entreprise,zone,metier,status,archive,tarif_actif,google_ads_campaign_resource`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const sites = await resp.json();
    return res.status(200).json({ success: true, sites });
  } catch (err) {
    console.error('Erreur mes-sites :', err);
    return res.status(500).json({ success: false, error: 'Impossible de récupérer vos sites pour le moment.' });
  }
}
