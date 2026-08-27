// /api/verify-send-code.js
// Envoie un code de vérification par SMS via Twilio Verify (même compte que le système EcoSky).
// Variables d'environnement requises (à copier depuis le projet salesflow-ecosky) :
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_VERIFY_SERVICE_SID

import twilio from 'twilio';

function toE164(rawPhone) {
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { telephone } = req.body || {};
  const phoneE164 = toE164(telephone || '');
  if (!phoneE164) {
    return res.status(400).json({ success: false, error: 'Numéro de téléphone invalide.' });
  }

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: phoneE164, channel: 'sms' });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur envoi code SMS :', err);
    return res.status(500).json({ success: false, error: "Impossible d'envoyer le code. Vérifiez le numéro et réessayez." });
  }
}
