// /api/relancer-devis.js
// Réécrit le 03/09 : ne s'occupe plus QUE de l'envoi du SMS de relance —
// même raisonnement que api/envoyer-devis.js (voir son en-tête). La
// lecture/écriture du lead se fait depuis mon-dashboard.html (clé publique).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_ANON_KEY (lecture seule, publique)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

const SITE_BASE_URL = 'https://www.skyeco.fr';

function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

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
    body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Twilio a refusé l'envoi du SMS : ${detail}`);
  }
}

const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrbGRkd3VtaXJrZGprYnh2enlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMTMzNDksImV4cCI6MjA5ODc4OTM0OX0._2cVv3rmhHb-7VLTCqiMRq0F2S30NMnD8qRhTiBM7nc';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draftId, telephone, prenom, devisToken } = req.body || {};
  if (!draftId || !telephone || !devisToken) {
    return res.status(400).json({ error: 'draftId, telephone ou devisToken manquant' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wklddwumirkdjkbxvzyj.supabase.co';

  try {
    const draftResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,twilio_phone_number`,
      { headers: { apikey: SUPABASE_ANON_KEY } }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0] || {};
    const nomEntreprise = draft.entreprise || 'Votre artisan';

    const lien = `${SITE_BASE_URL}/signer-devis.html?t=${devisToken}`;
    const prenomLead = (prenom || '').trim();
    const texte = `Bonjour${prenomLead ? ' ' + prenomLead : ''}, petit rappel : ${nomEntreprise} attend votre retour sur le devis envoyé. Vous pouvez le consulter et le signer ici : ${lien}`;
    await envoyerSMS(telephone, texte, draft.twilio_phone_number);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur relancer-devis :', err);
    return res.status(500).json({ error: err.message || "La relance n'a pas pu être envoyée." });
  }
}
