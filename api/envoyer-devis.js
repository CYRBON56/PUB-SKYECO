// /api/envoyer-devis.js
// Réécrit le 03/09 (deuxième version) : l'écriture (PATCH) sur
// skyeco_pro_leads REQUIERT la clé service_role — la table est verrouillée
// en écriture pour la clé publique (confirmé par l'erreur Postgres 42501
// "permission denied", policy RLS volontaire). Le vrai bug qui bloquait tout
// depuis le début était en fait les colonnes devis_* manquantes sur la
// table (erreur 42703), pas la configuration de SUPABASE_SERVICE_ROLE_KEY —
// une fois les colonnes créées, cette approche fonctionne normalement.
//
// La LECTURE (trouver le lead, vérifier son téléphone) reste faite côté
// client avec la clé publique (autorisée en lecture) pour rester rapide ;
// ce endpoint ne fait que l'écriture + le SMS.
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

  const { draftId, leadId, telephone, prenom, devisToken, pdfUrl } = req.body || {};
  if (!draftId || !leadId || !telephone || !devisToken || !pdfUrl) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('envoyer-devis : variable manquante —', { SUPABASE_URL_present: !!SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY_present: !!SERVICE_KEY });
    return res.status(500).json({ error: "Configuration serveur incomplète — contactez le support." });
  }
  const supaHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  try {
    // 1. Écriture du devis (nécessite la clé service_role).
    const patchResp = await fetch(`${SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        devis_pdf_url: pdfUrl,
        devis_statut: 'envoye',
        devis_token: devisToken,
        devis_envoye_le: new Date().toISOString(),
      }),
    });
    if (!patchResp.ok) {
      const errData = await patchResp.text().catch(() => '');
      console.error('envoyer-devis : échec PATCH —', patchResp.status, errData);
      throw new Error(`Échec de l'enregistrement du devis : ${errData}`);
    }

    // 2. SMS avec le lien de signature.
    const draftResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0] || {};
    const nomEntreprise = draft.entreprise || 'Votre artisan';

    const lien = `${SITE_BASE_URL}/signer-devis.html?t=${devisToken}`;
    const prenomLead = (prenom || '').trim();
    const texte = `Bonjour${prenomLead ? ' ' + prenomLead : ''}, ${nomEntreprise} vous a envoyé votre devis. Consultez-le et signez-le en ligne ici : ${lien}`;
    await envoyerSMS(telephone, texte, draft.twilio_phone_number);

    return res.status(200).json({ success: true, lien });
  } catch (err) {
    console.error('Erreur envoyer-devis :', err);
    return res.status(500).json({ error: err.message || "Le devis n'a pas pu être envoyé." });
  }
}
