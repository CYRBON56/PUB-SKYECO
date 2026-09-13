// /api/demander-connexion-google-business.js
// Un artisan clique "Connecter ma fiche Google" dans l'onglet Réseaux sociaux
// (mon-dashboard.html) — contrairement à Instagram/Facebook, la connexion
// Google Business Profile n'est PAS un OAuth self-service depuis le
// dashboard : elle passe par Windsor.ai (même compte que Google Ads), et
// c'est Cyrille qui doit la faire depuis son propre compte Windsor.ai, puis
// renseigner `google_business_location_id` sur la vitrine correspondante
// (voir lib/social-publish.js). Ce endpoint se contente donc de notifier
// Cyrille par SMS+email pour qu'il s'en occupe — calqué sur
// api/demander-formulaire-personnalise.js (même mécanisme de notification).
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
    const lienDashboard = `https://www.skyeco.fr/mon-dashboard.html?id=${draftId}`;
    const texte = `🔔 ${nomAffiche} demande la connexion de sa fiche Google (Google Business Profile) depuis le dashboard Réseaux sociaux — à faire manuellement via Windsor.ai (connecteur google_my_business), puis renseigner google_business_location_id sur cette vitrine.${coordonnees ? ' Contact : ' + coordonnees + '.' : ''} Dashboard : ${lienDashboard}`;

    const resultats = await Promise.allSettled([
      envoyerSMS(ADMIN_PHONE, texte),
      envoyerEmail('🔔 Demande de connexion Google Business Profile — ' + nomAffiche, texte),
    ]);
    const [resultSms, resultEmail] = resultats;
    if (resultSms.status === 'rejected') console.error('Échec envoi SMS demander-connexion-google-business :', resultSms.reason);
    if (resultEmail.status === 'rejected') console.error('Échec envoi email demander-connexion-google-business :', resultEmail.reason);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur demander-connexion-google-business :', err);
    return res.status(500).json({ success: false, error: "La demande n'a pas pu être envoyée." });
  }
}
