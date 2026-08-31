// /api/envoyer-acces-dashboard.js
// Appelé juste après la confirmation du paiement (apercu.html, une fois
// api/confirm-payment validé) : envoie par SMS + email le lien vers
// acces-dashboard.html, où l'artisan crée son mot de passe (son identifiant
// est son email, déjà connu). Sert aussi de secours si l'artisan ferme la
// page avant la redirection automatique côté client.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

const SITE_BASE_URL = 'https://app.skyeco.fr';
const RESEND_FROM = 'Skyeco Pro <notifications@ecoskybyrms.fr>';

function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body, fromOverride) {
  if (!to) return { skipped: true };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = fromOverride || process.env.TWILIO_FROM_NUMBER;
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
    });
    return { success: resp.ok };
  } catch (e) {
    console.error('Erreur envoi SMS acces dashboard :', e);
    return { success: false };
  }
}

async function envoyerEmail(to, subject, html) {
  if (!to) return { skipped: true };
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
    });
    return { success: resp.ok };
  } catch (e) {
    console.error('Erreur envoi email acces dashboard :', e);
    return { success: false };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=telephone,email,entreprise,twilio_phone_number,dashboard_password_hash`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();
    const draft = rows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }

    const lien = `${SITE_BASE_URL}/acces-dashboard.html?id=${draftId}`;
    const dejaUnCompte = !!draft.dashboard_password_hash;
    const texte = dejaUnCompte
      ? `Votre formule Skyeco Pro est activée ! Retrouvez votre tableau de bord ici : ${lien}`
      : `Votre formule Skyeco Pro est activée ! Créez votre accès à votre tableau de bord (email + mot de passe) : ${lien}`;

    const [sms, email] = await Promise.allSettled([
      envoyerSMS(draft.telephone, texte, draft.twilio_phone_number),
      envoyerEmail(
        draft.email,
        'Votre tableau de bord Skyeco Pro est prêt',
        `<p>Bonjour,</p><p>Votre formule pour <strong>${draft.entreprise || 'votre entreprise'}</strong> est activée.</p><p>${dejaUnCompte ? 'Retrouvez votre tableau de bord ici' : 'Créez votre accès (email + mot de passe) pour retrouver votre tableau de bord à tout moment'} : <a href="${lien}">${lien}</a></p>`
      ),
    ]);

    return res.status(200).json({
      success: true,
      sms: sms.status === 'fulfilled' ? sms.value : { success: false },
      email: email.status === 'fulfilled' ? email.value : { success: false },
    });
  } catch (err) {
    console.error('Erreur envoyer-acces-dashboard :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
