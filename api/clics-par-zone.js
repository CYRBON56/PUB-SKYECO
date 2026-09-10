// /api/clics-par-zone.js
// Répartition géographique des clics Google Ads reçus (d'où viennent les
// clics), via les champs "geo_target_city" / "geo_target_region" de
// Windsor.ai — la localisation physique réelle de la personne au moment du
// clic (et non la configuration de ciblage de la campagne).
//
// 10/09/2026 : l'ancienne version utilisait les champs
// "click_view_location_of_presence_city/region", qui ne renvoient qu'un
// identifiant technique par zone (ex: "geoTargetConstants/9218241"), jamais
// le nom de la ville — d'où l'affichage "Secteur (réf. ...)" côté dashboard.
// Vérifié ce jour : les champs "geo_target_city" / "geo_target_region"
// (marqués "(Alias)" côté Windsor) renvoient directement le nom résolu
// ("Lorient", "Vannes"...) pour la même notion de localisation physique,
// sans configuration ni table de correspondance supplémentaire. Plus besoin
// de cache de noms — la table "geo_target_names" évoquée dans une version
// précédente de ce commentaire n'a jamais été créée et n'est plus utile.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

// Sécurité (06/09/2026) : voir api/bloquer-creneau.js — ce endpoint révélait
// la répartition géographique des clics (donnée commerciale) sur simple
// présentation d'un draft_id (non secret).
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
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draft_id, token } = req.body || {};
  if (!draft_id || !token) {
    return res.status(401).json({ error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draft_id))) {
    return res.status(401).json({ error: 'session_invalide' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=google_ads_campaign_resource`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];

    if (!draft?.google_ads_campaign_resource) {
      return res.status(200).json({ success: true, campagneExiste: false, zones: [] });
    }

    const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', draft.google_ads_campaign_resource]]));
    const champs = 'geo_target_city,geo_target_region,clicks';
    const url = `https://connectors.windsor.ai/google_ads?api_key=${process.env.WINDSOR_API_KEY}&fields=${champs}&filter=${filtre}&date_preset=last_30d`;

    const windsorResp = await fetch(url);
    const windsorData = await windsorResp.json();
    if (!windsorResp.ok) throw new Error(`Windsor.ai a répondu une erreur : ${JSON.stringify(windsorData)}`);

    const lignes = windsorData.data || [];

    // Regroupe par ville (repli sur la région si la ville n'est pas connue
    // pour ce clic — arrive pour certains clics mobiles/imprécis). Les deux
    // champs sont déjà des noms résolus, pas des identifiants.
    const totaux = new Map(); // nom -> clics
    for (const l of lignes) {
      const nom = l.geo_target_city || l.geo_target_region;
      if (!nom) continue;
      totaux.set(nom, (totaux.get(nom) || 0) + (Number(l.clicks) || 0));
    }

    const zones = [...totaux.entries()]
      .map(([nom, clics]) => ({ id: nom, nom, label: nom, clics }))
      .sort((a, b) => b.clics - a.clics)
      .slice(0, 10);

    const resolutionDisponible = zones.some(z => z.nom);

    return res.status(200).json({ success: true, campagneExiste: true, zones, resolutionDisponible });
  } catch (err) {
    console.error('Erreur clics-par-zone (Windsor.ai) :', err);
    return res.status(500).json({ error: err.message });
  }
}
