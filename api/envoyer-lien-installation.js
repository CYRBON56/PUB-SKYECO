// /api/envoyer-lien-installation.js
// Envoie par SMS, au numéro de l'artisan lui-même, un lien qui ouvre
// directement son tableau de bord sur son téléphone (sans avoir à se
// reconnecter) — pratique quand il configure son compte depuis son
// ordinateur et veut ensuite installer l'app sur son téléphone.
//
// Le lien porte ?installer=1, lu par mon-dashboard.html pour afficher le
// bandeau "Ajouter à l'écran d'accueil" une fois arrivé sur le dashboard.
//
// Sécurité (cohérent avec le reste du dashboard depuis l'audit du 06/09,
// voir api/bloquer-creneau.js/definir-budget-journalier.js) : exige un
// jeton de session valide pour CE draftId avant d'envoyer quoi que ce
// soit — sinon n'importe qui connaissant un draftId (non secret, publié
// dans les annonces) pourrait spammer par SMS le téléphone d'un artisan.
//
// Variables d'environnement requises :
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
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

// Jeton admin longue durée (24h — juste pour le confort d'ouvrir le SMS
// quand l'artisan le souhaite, pas une action sensible en soi une fois émis
// puisqu'il ne fait qu'ouvrir SON PROPRE dashboard).
function signerLienInstallation(draftId) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
  const payload = `${draftId}.admin.${exp}`;
  const sig = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
  });
  if (!resp.ok) throw new Error(`Twilio a répondu ${resp.status} : ${await resp.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée.' });
  }
  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
  }

  const autorise = await verifierToken(token, draftId);
  if (!autorise) {
    return res.status(401).json({ success: false, error: 'Session invalide.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const draftRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=telephone`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const drafts = await draftRes.json();
    const telephone = drafts[0]?.telephone;
    if (!telephone) {
      return res.status(400).json({ success: false, error: "Aucun numéro de téléphone enregistré sur ce compte." });
    }

    const lienToken = signerLienInstallation(draftId);
    const base = process.env.SITE_BASE_URL || 'https://www.skyeco.fr';
    const lien = `${base}/mon-dashboard.html?id=${draftId}&admin_token=${lienToken}&installer=1`;

    await envoyerSMS(
      telephone,
      `Skyeco Pro — voici le lien vers votre tableau de bord sur ce téléphone : ${lien}\nUne fois ouvert, suivez l'invite pour l'ajouter à votre écran d'accueil.`
    );

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('Erreur envoyer-lien-installation :', e);
    return res.status(500).json({ success: false, error: "Échec de l'envoi du SMS." });
  }
}
