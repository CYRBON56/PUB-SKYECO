// /api/relancer-devis.js
// Réécrit le 03/09 (deuxième version) : même raisonnement que
// api/envoyer-devis.js — l'écriture sur skyeco_pro_leads requiert la clé
// service_role (RLS verrouillée), la lecture reste faite côté client avec
// la clé publique.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

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

const SITE_BASE_URL = 'https://www.skyeco.fr';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draftId, leadId, telephone, prenom, devisToken, nbRelancesActuel } = req.body || {};
  if (!draftId || !leadId || !telephone || !devisToken) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('relancer-devis : variable manquante —', { SUPABASE_URL_present: !!SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY_present: !!SERVICE_KEY });
    return res.status(500).json({ error: "Configuration serveur incomplète — contactez le support." });
  }
  const supaHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const draftResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0] || {};
    const nomEntreprise = draft.entreprise || 'Votre artisan';

    const lien = `${SITE_BASE_URL}/signer-devis.html?t=${devisToken}`;
    const prenomLead = (prenom || '').trim();
    const texte = `Bonjour${prenomLead ? ' ' + prenomLead : ''}, petit rappel : ${nomEntreprise} attend votre retour sur le devis envoyé. Vous pouvez le consulter et le signer ici : ${lien}`;
    await envoyerSMS(telephone, texte, draft.twilio_phone_number);

    const patchResp = await fetch(`${SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ devis_statut: 'relance', devis_nb_relances: (nbRelancesActuel || 0) + 1 }),
    });
    if (!patchResp.ok) {
      const errData = await patchResp.text().catch(() => '');
      console.error('relancer-devis : échec PATCH —', patchResp.status, errData);
      throw new Error(`Échec de la mise à jour du statut : ${errData}`);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur relancer-devis :', err);
    return res.status(500).json({ error: err.message || "La relance n'a pas pu être envoyée." });
  }
}
