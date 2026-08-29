// /api/envoyer-lien-elements.js
// Envoie par SMS le lien personnalisé vers mes-elements.html à l'artisan
// concerné, pour qu'il puisse déposer ses vrais éléments (logo, photos,
// légal, chiffrage).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

const SITE_BASE_URL = 'https://pub-skyeco-23ue.vercel.app';

async function envoyerSMS(to, body, fromOverride) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = fromOverride || process.env.TWILIO_FROM_NUMBER;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Échec envoi SMS');
  return data;
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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=telephone,entreprise,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();
    const draft = rows[0];

    if (!draft) return res.status(404).json({ success: false, error: 'Site introuvable.' });
    if (!draft.telephone) return res.status(400).json({ success: false, error: "Aucun téléphone enregistré pour ce site." });

    const lien = `${SITE_BASE_URL}/mes-elements.html?id=${draftId}`;
    const texte = `Bonjour, suite à notre échange, voici le lien pour nous transmettre vos éléments (logo, photos, coordonnées) et construire votre vraie vitrine : ${lien}`;

    await envoyerSMS(draft.telephone, texte, draft.twilio_phone_number);

    return res.status(200).json({ success: true, lien });
  } catch (err) {
    console.error('Erreur envoyer-lien-elements :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
