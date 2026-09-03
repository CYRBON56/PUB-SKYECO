// /api/dashboard-verify-session.js
// Vérifie qu'un jeton de session est valide pour CE draftId précis, avant
// de laisser mon-dashboard.html afficher les données. Deux types de jeton :
//
// - role 'admin' (dashboard-admin-token.js, accès direct depuis
//   mes-artisans.html) : lié à UN SEUL draftId précis — comparaison
//   directe, comme avant.
// - role 'artisan' (dashboard-login.js / dashboard-set-password.js /
//   dashboard-reset-password.js) : lié à un COMPTE (email), pas à un site
//   précis, car un artisan peut posséder plusieurs vitrines sous le même
//   compte — on vérifie ici que le draftId demandé appartient bien à cet
//   email, en base.
//
// Variables d'environnement requises :
//   DASHBOARD_SESSION_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (vérification email -> draftId des jetons artisan)

import crypto from 'crypto';

function decoderEtVerifierSignature(token) {
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

    return { sujet, role };
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false });
  }
  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(400).json({ valid: false });
  }

  const resultat = decoderEtVerifierSignature(token);
  if (!resultat) {
    return res.status(401).json({ valid: false });
  }

  // Jeton admin : le "sujet" est directement le draftId autorisé.
  if (resultat.role === 'admin') {
    if (resultat.sujet !== draftId) {
      return res.status(401).json({ valid: false });
    }
    return res.status(200).json({ valid: true, role: 'admin' });
  }

  // Jeton artisan : le "sujet" est l'email du compte (encodé base64url) —
  // valable pour TOUTES les vitrines rattachées à cet email.
  if (resultat.role === 'artisan') {
    let email;
    try {
      email = Buffer.from(resultat.sujet, 'base64url').toString('utf8');
    } catch (e) {
      return res.status(401).json({ valid: false });
    }
    if (!email) {
      return res.status(401).json({ valid: false });
    }

    try {
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=email`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const rows = await resp.json();
      const draft = rows[0];
      if (!draft || !draft.email || draft.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(401).json({ valid: false });
      }
      return res.status(200).json({ valid: true, role: 'artisan' });
    } catch (err) {
      console.error('Erreur dashboard-verify-session :', err);
      return res.status(500).json({ valid: false });
    }
  }

  return res.status(401).json({ valid: false });
}
