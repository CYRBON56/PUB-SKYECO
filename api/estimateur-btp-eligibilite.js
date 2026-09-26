// /api/estimateur-btp-eligibilite.js
// Indique si l'artisan authentifié sur SON dashboard Skyeco Pro (mon-dashboard.html)
// a déjà payé pour l'Estimateur BTP (achat direct via Stripe, ou accès offert
// via le Kit Pro Artisan BTP, qui l'inclut) — sert à afficher ou non l'onglet
// "Estimateur BTP" dans la barre latérale du dashboard (26/09/2026, demande de
// Cyrille : les artisans qui achètent l'estimateur AVANT de s'inscrire à
// Skyeco Pro doivent pouvoir le retrouver directement depuis leur dashboard).
//
// Requête attendue : POST { draftId, token } — même jeton de session que les
// autres endpoints du dashboard (api/mes-leads.js, etc.), même logique de
// vérification (copiée ici faute de lib partagée dans ce projet).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

async function supabaseGet(path) {
  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!resp.ok) return [];
  return resp.json();
}

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
      const rows = await supabaseGet(`skyeco_pro_vitrine_drafts?id=eq.${draftIdAttendu}&select=email`);
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

// Sources d'estimateur_btp_acces considérées comme "a déjà payé" — même
// logique que api/create-checkout-session.js (remise fidélité).
const SOURCES_ESTIMATEUR_PAYEES = ['stripe', 'kit_pro'];

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

  try {
    // Email de l'artisan : porté directement par un jeton "artisan" ; pour un
    // jeton "admin" (accès de Cyrille, une seule vitrine), on le retrouve via
    // le brouillon.
    let email = roleDuToken(token) === 'artisan' ? emailDuTokenArtisan(token) : null;
    if (!email) {
      const rows = await supabaseGet(`skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=email`);
      email = rows[0]?.email || null;
    }
    if (!email) {
      return res.status(200).json({ success: true, eligible: false });
    }

    const acces = await supabaseGet(
      `estimateur_btp_acces?email=eq.${encodeURIComponent(String(email).toLowerCase())}&select=source&limit=1`
    );
    const source = acces?.[0]?.source;
    return res.status(200).json({ success: true, eligible: SOURCES_ESTIMATEUR_PAYEES.includes(source) });
  } catch (err) {
    console.error('estimateur-btp-eligibilite error:', err.message);
    // En cas de doute, pas d'onglet affiché plutôt qu'une erreur visible —
    // ce n'est qu'un confort d'accès, jamais bloquant.
    return res.status(200).json({ success: true, eligible: false });
  }
}
