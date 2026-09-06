// /api/verify-send-code.js
// Envoie un code de vérification par SMS via Twilio Verify (même compte que le système EcoSky).
// Variables d'environnement requises (à copier depuis le projet salesflow-ecosky) :
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_VERIFY_SERVICE_SID

import twilio from 'twilio';
import { ipDepuisRequete, verifierLimite } from './_lib/rate-limit.js';

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

  // Sécurité (06/09/2026) : sans limite, ce endpoint public permettait
  // d'envoyer un nombre illimité de SMS Twilio Verify vers N'IMPORTE QUEL
  // numéro (harcèlement d'un tiers par SMS répétés, coût Twilio pour
  // Cyrille). Double limite : par numéro visé (protège la victime, même si
  // l'attaquant change d'IP) et par IP appelante (freine un attaquant qui
  // viserait beaucoup de numéros différents).
  const ip = ipDepuisRequete(req);
  const [autoriseParNumero, autoriseParIp] = await Promise.all([
    verifierLimite(`verify-send-code:tel:${phoneE164}`, 3, 15 * 60),
    verifierLimite(`verify-send-code:ip:${ip}`, 10, 15 * 60),
  ]);
  if (!autoriseParNumero || !autoriseParIp) {
    return res.status(429).json({ success: false, error: 'Trop de tentatives. Merci de réessayer dans quelques minutes.' });
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
