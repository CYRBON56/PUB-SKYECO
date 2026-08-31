// /api/relancer-devis.js
// Renvoie un SMS de relance avec le même lien de signature (le devis a déjà
// été uploadé et envoyé une première fois via api/envoyer-devis.js).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

const SITE_BASE_URL = 'https://app.skyeco.fr';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { leadId } = req.body || {};
  if (!leadId) {
    return res.status(400).json({ error: 'leadId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const leadResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&select=id,draft_id,nom,prenom,telephone,devis_statut,devis_token,devis_nb_relances`,
      { headers: supaHeaders }
    );
    const leadRows = await leadResp.json();
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ error: 'Demande introuvable.' });
    if (!lead.devis_token || lead.devis_statut === 'aucun') {
      return res.status(400).json({ error: "Aucun devis n'a encore été envoyé pour ce prospect." });
    }
    if (lead.devis_statut === 'signe') {
      return res.status(409).json({ error: 'Ce devis est déjà signé — inutile de relancer.' });
    }
    if (!lead.telephone) return res.status(400).json({ error: "Ce prospect n'a pas de numéro de téléphone enregistré." });

    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${lead.draft_id}&select=entreprise,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0] || {};
    const nomEntreprise = draft.entreprise || 'Votre artisan';

    const lien = `${SITE_BASE_URL}/signer-devis.html?t=${lead.devis_token}`;
    const prenomLead = (lead.prenom || '').trim();
    const texte = `Bonjour${prenomLead ? ' ' + prenomLead : ''}, petit rappel : ${nomEntreprise} attend votre retour sur le devis envoyé. Vous pouvez le consulter et le signer ici : ${lien}`;
    await envoyerSMS(lead.telephone, texte, draft.twilio_phone_number);

    const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        devis_statut: 'relance',
        devis_nb_relances: (lead.devis_nb_relances || 0) + 1,
      }),
    });
    if (!patchResp.ok) {
      const errData = await patchResp.text().catch(() => '');
      throw new Error(`Échec de la mise à jour du statut : ${errData}`);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur relancer-devis :', err);
    return res.status(500).json({ error: err.message || "La relance n'a pas pu être envoyée." });
  }
}
