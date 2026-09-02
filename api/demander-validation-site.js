// /api/demander-validation-site.js
// Un artisan bloqué sur choisir-forfait.html (site pas encore validé par
// Cyrille — voir site_valide sur skyeco_pro_vitrine_drafts) clique sur
// "Demander la validation à Cyrille" : ça génère un jeton à usage unique et
// envoie un SMS+email à Cyrille avec un lien direct vers valider-site.html,
// qui affiche le nom de l'artisan et un bouton de confirmation avant de
// poser site_valide=true.
//
// Colonne Supabase requise sur skyeco_pro_vitrine_drafts (à créer si
// absente) :
//   validation_token   text
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   RESEND_API_KEY, ADMIN_EMAIL, ADMIN_PHONE

import crypto from 'crypto';

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
    const token = crypto.randomBytes(24).toString('hex');

    const patchResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({ validation_token: token }),
      }
    );
    if (!patchResp.ok) throw new Error(await patchResp.text());
    const rows = await patchResp.json();
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Brouillon introuvable' });
    }
    const entreprise = rows[0].entreprise || 'Un artisan';

    const lien = `https://www.skyeco.fr/valider-site.html?id=${draftId}&token=${token}`;
    const texte = `🔔 ${entreprise} demande la validation de son site Skyeco pour pouvoir payer/démarrer son essai. Valider : ${lien}`;

    const resultats = await Promise.allSettled([
      envoyerSMS(ADMIN_PHONE, texte),
      envoyerEmail('🔔 Demande de validation de site — ' + entreprise, texte),
    ]);
    const [resultSms, resultEmail] = resultats;
    if (resultSms.status === 'rejected') console.error('Échec envoi SMS validation-site :', resultSms.reason);
    if (resultEmail.status === 'rejected') console.error('Échec envoi email validation-site :', resultEmail.reason);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur demander-validation-site :', err);
    return res.status(500).json({ success: false, error: "La demande n'a pas pu être envoyée." });
  }
}
