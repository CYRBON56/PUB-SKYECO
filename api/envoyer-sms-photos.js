// /api/envoyer-sms-photos.js
// Appelé depuis apercu.html (bouton "Envoyer mes photos par SMS" affiché
// après l'enregistrement d'une demande) : génère un jeton à usage unique,
// l'attache au lead concerné, et envoie un SMS au prospect avec un lien vers
// public/envoyer-photos.html — une page pensée pour être ouverte directement
// depuis le téléphone (accès à l'appareil photo), dont les photos uploadées
// se rattachent automatiquement à sa demande.
//
// Colonnes Supabase requises sur skyeco_pro_leads (à créer si absentes) :
//   photos          jsonb   (tableau d'URLs, défaut '[]')
//   photos_token    text
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import crypto from 'crypto';

function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body, fromOverride) {
  if (!to) throw new Error('Numéro manquant');
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = fromOverride || process.env.TWILIO_FROM_NUMBER;
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { leadId, telephone } = req.body || {};
  if (!leadId || !telephone) {
    return res.status(400).json({ success: false, error: 'leadId et telephone requis.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const token = crypto.randomBytes(20).toString('hex');

    // Numéro dédié de l'artisan si disponible (via son brouillon), sinon
    // numéro Skyeco Pro partagé — récupéré via le lead pour ne pas avoir à
    // le redemander à apercu.html.
    const leadResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&select=draft_id`,
      { headers: supaHeaders }
    );
    const leadRows = await leadResp.json();
    const draftId = leadRows[0]?.draft_id;
    let numeroExpediteur = null;
    if (draftId) {
      const draftResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=twilio_phone_number`,
        { headers: supaHeaders }
      );
      const draftRows = await draftResp.json();
      numeroExpediteur = draftRows[0]?.twilio_phone_number || null;
    }

    const patchResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ photos_token: token }),
      }
    );
    if (!patchResp.ok) throw new Error(await patchResp.text());

    const lien = `https://www.skyeco.fr/envoyer-photos.html?lead=${leadId}&token=${token}`;
    await envoyerSMS(
      telephone,
      `Envoyez vos photos ici, directement depuis votre téléphone : ${lien}`,
      numeroExpediteur
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur envoyer-sms-photos :', err);
    return res.status(500).json({ success: false, error: "Le SMS n'a pas pu être envoyé." });
  }
}
