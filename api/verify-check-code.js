// /api/verify-check-code.js
// Vérifie le code SMS saisi par l'utilisateur via Twilio Verify.
// Variables d'environnement requises (identiques à verify-send-code.js) :
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

  const { telephone, code } = req.body || {};
  const phoneE164 = toE164(telephone || '');
  if (!phoneE164 || !code) {
    return res.status(400).json({ success: false, error: 'Numéro ou code manquant.' });
  }

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({ to: phoneE164, code });

    if (check.status !== 'approved') {
      return res.status(200).json({ success: true, verified: false, error: 'Code incorrect.' });
    }
    return res.status(200).json({ success: true, verified: true });
  } catch (err) {
    console.error('Erreur vérification code SMS :', err);
    return res.status(500).json({ success: false, error: 'Impossible de vérifier le code. Réessayez.' });
  }
}
