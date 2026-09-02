// /api/alerter-changement-zone.js
// Envoie une alerte SMS + email à Cyrille dès qu'un artisan modifie sa zone
// ou son rayon de ciblage depuis mon-dashboard.html — le connecteur utilisé
// pour Google Ads (Windsor.ai) ne permet pas de poser le ciblage
// géographique automatiquement (voir api/create-google-ads-campaign.js),
// donc Cyrille doit aller le mettre à jour manuellement dans Google Ads à
// chaque changement.
//
// Variables d'environnement requises :
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   RESEND_API_KEY, ADMIN_EMAIL, ADMIN_PHONE

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'infos@ecosky.fr';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body) {
  if (!to) throw new Error('ADMIN_PHONE est vide');
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

async function envoyerEmail(sujet, texte) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Skyeco Pro <notifications@ecoskybyrms.fr>',
      to: [ADMIN_EMAIL],
      subject: sujet,
      html: `<p>${texte}</p>`,
    }),
  });
  if (!resp.ok) throw new Error(`Resend a répondu ${resp.status} : ${await resp.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, entreprise, zone, rayon } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  const lien = `https://www.skyeco.fr/mon-dashboard.html?id=${draftId}`;
  const precisionRayon = rayon ? ` (rayon ${rayon} km)` : '';
  const texte = `📍 ${entreprise || 'Un artisan'} a changé sa zone de ciblage : "${zone}"${precisionRayon} — pense à mettre à jour le ciblage géographique dans Google Ads. ${lien}`;

  const resultats = await Promise.allSettled([
    envoyerSMS(ADMIN_PHONE, texte),
    envoyerEmail('📍 Changement de zone à reporter dans Google Ads — ' + (entreprise || 'Artisan'), texte),
  ]);
  const [resultSms, resultEmail] = resultats;
  if (resultSms.status === 'rejected') console.error('Échec envoi SMS alerte-zone :', resultSms.reason);
  if (resultEmail.status === 'rejected') console.error('Échec envoi email alerte-zone :', resultEmail.reason);

  // Toujours 200 : un échec d'envoi de l'alerte ne doit jamais empêcher
  // l'artisan de voir sa propre sauvegarde de zone réussir côté dashboard.
  return res.status(200).json({ success: true });
}
