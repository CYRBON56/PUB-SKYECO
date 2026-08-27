// /api/send-campaign-sms.js
// Envoie un SMS de prospection à une liste de prospects (Twilio — même compte que les autres SMS Skyeco Pro).
// Variables d'environnement requises : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import twilio from 'twilio';

function toE164(rawPhone) {
  const digits = (rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { prospects, message } = req.body || {};
  if (!Array.isArray(prospects) || !prospects.length || !message) {
    return res.status(400).json({ success: false, error: 'Prospects ou message manquant.' });
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
    return res.status(500).json({ success: false, error: 'Configuration Twilio incomplète côté serveur.' });
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const results = { sent: [], failed: [] };

  for (const p of prospects) {
    const to = toE164(p.telephone);
    if (!to) {
      results.failed.push({ id: p.id, error: 'Numéro invalide' });
      continue;
    }
    try {
      await client.messages.create({
        to,
        from: process.env.TWILIO_FROM_NUMBER,
        body: message
      });
      results.sent.push(p.id);
    } catch (err) {
      results.failed.push({ id: p.id, error: err.message });
    }
  }

  return res.status(200).json({ success: true, ...results });
}
