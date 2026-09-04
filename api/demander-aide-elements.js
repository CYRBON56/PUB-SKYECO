// /api/demander-aide-elements.js
// Bouton "🆘 Besoin d'aide pour remplir mes éléments" dans mes-elements.html
// — un artisan bloqué ou perdu dans le formulaire clique dessus, ça envoie
// un SMS+email à Cyrille pour qu'il le recontacte et l'aide à compléter sa
// vitrine. Peut être cliqué autant de fois que nécessaire (pas de garde-fou
// "une seule demande") — c'est un appel à l'aide ponctuel, pas un état
// persistant.
// Calqué sur api/demander-validation-site.js / api/demander-formulaire-personnalise.js
// (même mécanisme de notification admin).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const getResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,telephone,email`,
      { headers: supaHeaders }
    );
    if (!getResp.ok) throw new Error(await getResp.text());
    const rows = await getResp.json();
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Brouillon introuvable' });
    }
    const { entreprise, telephone, email } = rows[0];
    const nomAffiche = entreprise || 'Un artisan';

    const coordonnees = [telephone, email].filter(Boolean).join(' — ');
    const lienElements = `https://www.skyeco.fr/mes-elements.html?id=${draftId}`;
    const texte = `🆘 ${nomAffiche} demande de l'aide pour remplir ses éléments (mes-elements.html).${coordonnees ? ' Contact : ' + coordonnees + '.' : ''} Sa page : ${lienElements}`;

    const resultats = await Promise.allSettled([
      envoyerSMS(ADMIN_PHONE, texte),
      envoyerEmail("🆘 Demande d'aide — " + nomAffiche, texte),
    ]);
    const [resultSms, resultEmail] = resultats;
    if (resultSms.status === 'rejected') console.error('Échec envoi SMS demander-aide-elements :', resultSms.reason);
    if (resultEmail.status === 'rejected') console.error('Échec envoi email demander-aide-elements :', resultEmail.reason);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur demander-aide-elements :', err);
    return res.status(500).json({ success: false, error: "La demande n'a pas pu être envoyée." });
  }
}
