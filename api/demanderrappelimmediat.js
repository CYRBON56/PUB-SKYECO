// /api/demander-rappel-immediat.js
// Un artisan, sur prochaines-etapes.html, demande à être rappelé tout de
// suite plutôt que de prendre un créneau Calendly — on notifie l'ADMIN
// (Cyrille), pas l'artisan (contrairement à notify-nouvelle-demande.js qui
// notifie l'artisan pour ses propres prospects).
//
// Variables d'environnement requises :
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   RESEND_API_KEY
//   ADMIN_EMAIL, ADMIN_PHONE

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'infos@ecosky.fr';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

// Twilio exige un numero au format E.164 (+33...) pour le parametre "To" des
// SMS envoyes via l'API Messages (contrairement a Twilio Verify, deja converti
// ailleurs). Les numeros stockes en base viennent du formulaire d'inscription
// au format national francais ("06 12 34 56 78"), jamais convertis avant ces
// envois -> Twilio les rejetait silencieusement (erreur 21211, capturee par le
// try/catch), d'ou les echecs d'envoi. Idempotent : ne change rien a un numero
// deja au format E.164.
function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body) {
  if (!to) return;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
  });
}

async function envoyerEmail(sujet, texte) {
  await fetch('https://api.resend.com/emails', {
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
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { nom, telephone, draftId } = req.body || {};
  if (!nom || !telephone) {
    return res.status(400).json({ success: false, error: 'Nom et téléphone requis.' });
  }

  const texte = `⚡ Rappel immédiat demandé — ${nom} (${telephone}).` + (draftId ? ` Fiche : ${draftId}` : '');

  try {
    await Promise.allSettled([
      envoyerSMS(ADMIN_PHONE, texte),
      envoyerEmail('⚡ Demande de rappel immédiat', texte),
    ]);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur demander-rappel-immediat :', err);
    return res.status(500).json({ success: false, error: "La demande n'a pas pu être envoyée." });
  }
}
