// /api/dashboard-rappel-identifiant.js
// "Identifiant oublié" : l'identifiant de connexion est l'email déjà déposé
// par l'artisan. S'il ne s'en souvient plus, il donne son numéro de
// téléphone (qu'il connaît forcément) et on le lui rappelle par SMS,
// partiellement masqué par précaution. Réponse toujours identique, que le
// téléphone corresponde à un compte ou non.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

const REPONSE_GENERIQUE = { success: true, message: 'Si ce numéro correspond à un compte, votre identifiant vient de vous être envoyé par SMS.' };

function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

function masquerEmail(email) {
  const [nomPart, domaine] = String(email).split('@');
  if (!domaine) return email;
  const visible = nomPart.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, nomPart.length - 2))}@${domaine}`;
}

async function envoyerSMS(to, body, fromOverride) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = fromOverride || process.env.TWILIO_FROM_NUMBER;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json(REPONSE_GENERIQUE);
  }
  const { telephone } = req.body || {};
  if (!telephone) {
    return res.status(200).json(REPONSE_GENERIQUE);
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const numero = toE164(telephone);
    // Même précaution que dashboard-login.js : un numéro peut correspondre à
    // plusieurs brouillons, on ne veut rappeler que l'email du compte
    // dashboard réellement créé (le plus récent si plusieurs).
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?telephone=eq.${encodeURIComponent(telephone.trim())}&dashboard_password_hash=not.is.null&order=dashboard_compte_cree_le.desc&limit=1&select=email,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();
    const draft = rows[0];

    if (draft && draft.email) {
      await envoyerSMS(
        numero,
        `Skyeco Pro : votre identifiant de connexion au tableau de bord est votre email : ${masquerEmail(draft.email)}`,
        draft.twilio_phone_number
      ).catch((e) => console.error('Erreur SMS rappel identifiant :', e));
    }

    return res.status(200).json(REPONSE_GENERIQUE);
  } catch (err) {
    console.error('Erreur dashboard-rappel-identifiant :', err);
    return res.status(200).json(REPONSE_GENERIQUE);
  }
}
