// /api/dashboard-forgot-password.js
// "Mot de passe oublié" : l'artisan saisit son email (son identifiant), on
// lui envoie par SMS + email un lien à durée limitée (1h) pour choisir un
// nouveau mot de passe. Réponse volontairement identique que l'email existe
// ou non, pour ne pas laisser deviner les comptes existants.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import crypto from 'crypto';

const SITE_BASE_URL = 'https://pub-skyeco-23ue.vercel.app';
const RESEND_FROM = 'Skyeco Pro <notifications@ecoskybyrms.fr>';
const REPONSE_GENERIQUE = { success: true, message: 'Si un compte existe avec cet email, un lien de réinitialisation vient de vous être envoyé par SMS et par email.' };

// Twilio exige un numero au format E.164 (+33...) pour le parametre "To" des
// SMS envoyes via l'API Messages (voir le meme correctif applique dans les
// autres fichiers d'envoi SMS de ce repo).
function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body, fromOverride) {
  if (!to) return;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = fromOverride || process.env.TWILIO_FROM_NUMBER;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
    });
  } catch (e) {
    console.error('Erreur envoi SMS reinitialisation :', e);
  }
}

async function envoyerEmail(to, subject, html) {
  if (!to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
    });
  } catch (e) {
    console.error('Erreur envoi email reinitialisation :', e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json(REPONSE_GENERIQUE);
  }
  const { email } = req.body || {};
  if (!email) {
    return res.status(200).json(REPONSE_GENERIQUE);
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?email=ilike.${encodeURIComponent(email.trim())}&select=id,telephone,twilio_phone_number,entreprise`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();
    const draft = rows[0];

    if (draft) {
      const token = crypto.randomBytes(24).toString('hex');
      const expire = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h

      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ dashboard_reset_token: token, dashboard_reset_token_expire: expire }),
      });

      const lien = `${SITE_BASE_URL}/dashboard-nouveau-mot-de-passe.html?id=${draft.id}&token=${token}`;
      const texteMessage = `Skyeco Pro : voici votre lien pour choisir un nouveau mot de passe (valable 1h) : ${lien}`;

      await Promise.allSettled([
        envoyerSMS(draft.telephone, texteMessage, draft.twilio_phone_number),
        envoyerEmail(
          email,
          'Réinitialisation de votre mot de passe — Skyeco Pro',
          `<p>Bonjour,</p><p>Vous avez demandé à réinitialiser le mot de passe de votre tableau de bord Skyeco Pro${draft.entreprise ? ' (' + draft.entreprise + ')' : ''}.</p><p><a href="${lien}">Choisir un nouveau mot de passe</a></p><p>Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.</p>`
        ),
      ]);
    }

    // Toujours la même réponse, que l'email corresponde à un compte ou non.
    return res.status(200).json(REPONSE_GENERIQUE);
  } catch (err) {
    console.error('Erreur dashboard-forgot-password :', err);
    return res.status(200).json(REPONSE_GENERIQUE);
  }
}
