// /api/coach-toggle.js
// Permet à l'artisan de mettre le Coach IA Ads en pause (ou de le
// réactiver) depuis son tableau de bord — demandé par Cyrille le 04/09,
// suite à la mise en place du coach capable d'agir seul sur la campagne
// (voir coach-ads.js). Tant que le coach est en pause :
//   - /api/coach-ads ne fait plus AUCUN appel à Claude (ni analyse
//     automatique, ni chat, ni action) pour ce draftId — voir la
//     vérification `coach_ia_pause` en tête de ce fichier.
// Ne touche ni à la diffusion de la campagne (campagne_diffusion_pausee,
// géré par pause-campagne-ads.js) ni à rien d'autre : uniquement le
// coach lui-même.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

// Sécurité (06/09/2026) : voir api/bloquer-creneau.js pour le détail — même
// vérification de jeton, ce endpoint ne vérifiait auparavant que le draftId
// (non secret), ce qui permettait à n'importe qui de couper le coach IA
// d'un artisan.
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
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token, pause } = req.body || {};
  if (!draftId || !token || typeof pause !== 'boolean') {
    return res.status(400).json({ success: false, error: 'draftId, token et pause (booléen) requis.' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ coach_ia_pause: pause }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`Échec de la mise à jour Supabase : ${detail}`);
    }
    return res.status(200).json({ success: true, coachIaPause: pause });
  } catch (err) {
    console.error('Erreur coach-toggle :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
