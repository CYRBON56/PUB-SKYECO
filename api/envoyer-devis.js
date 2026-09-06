// /api/envoyer-devis.js
// Sécurité (06/09/2026) : cet endpoint faisait confiance à des valeurs
// (telephone, prenom) fournies directement par le NAVIGATEUR — rien ne
// vérifiait que l'appelant avait le droit d'agir sur ce lead, ni que ce
// numéro de téléphone était bien le vrai numéro du prospect. N'importe qui
// connaissant un leadId/draftId aurait pu faire envoyer un SMS (au nom de
// l'artisan, via son numéro Twilio) vers N'IMPORTE QUEL numéro, avec un
// lien de "devis" arbitraire — un vecteur de spam/abus du numéro Twilio.
//
// Cet endpoint vérifie maintenant un jeton de session (même schéma que
// api/mes-leads.js) et relit lui-même le téléphone/prénom du lead en base
// avec la clé service_role, au lieu de faire confiance au client. Le
// prospect n'est plus lu côté client avec la clé publique (verrouillée
// depuis la migration verrouiller_skyeco_pro_leads).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
import crypto from 'crypto';

async function verifierToken(token, draftIdAttendu) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return false;
    const [sujet, role, expStr, sig] = parties;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return false;
    const payload = `${sujet}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return false;
    if (role === 'admin') return sujet === draftIdAttendu;
    if (role === 'artisan') {
      let email;
      try { email = Buffer.from(sujet, 'base64url').toString('utf8'); } catch (e) { return false; }
      if (!email) return false;
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftIdAttendu}&select=email`,
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const rows = await resp.json();
      const draft = rows[0];
      return !!(draft && draft.email && draft.email.toLowerCase() === email.toLowerCase());
    }
    return false;
  } catch (e) { return false; }
}

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

  const { leadId, devisToken, pdfUrl, token } = req.body || {};
  if (!leadId || !devisToken || !pdfUrl || !token) {
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
    // 1. Relecture faisant autorité du lead (jamais de valeurs venant du client).
    const leadResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&select=id,prenom,telephone,devis_statut,draft_id`,
      { headers: supaHeaders }
    );
    if (!leadResp.ok) throw new Error('Lecture Supabase impossible : ' + (await leadResp.text()));
    const leadRows = await leadResp.json();
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ error: `Demande introuvable (id ${leadId}).` });

    if (!(await verifierToken(token, lead.draft_id))) {
      return res.status(401).json({ error: 'session_invalide' });
    }
    if (!lead.telephone) return res.status(400).json({ error: "Ce prospect n'a pas de numéro de téléphone enregistré." });
    if (lead.devis_statut === 'signe') return res.status(400).json({ error: 'Ce devis a déjà été signé — impossible de le remplacer depuis cet écran.' });

    // 2. Écriture du devis (nécessite la clé service_role).
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

    // 3. SMS avec le lien de signature.
    const draftResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${lead.draft_id}&select=entreprise,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0] || {};
    const nomEntreprise = draft.entreprise || 'Votre artisan';

    const lien = `${SITE_BASE_URL}/signer-devis.html?t=${devisToken}`;
    const prenomLead = (lead.prenom || '').trim();
    const texte = `Bonjour${prenomLead ? ' ' + prenomLead : ''}, ${nomEntreprise} vous a envoyé votre devis. Consultez-le et signez-le en ligne ici : ${lien}`;
    await envoyerSMS(lead.telephone, texte, draft.twilio_phone_number);

    return res.status(200).json({ success: true, lien });
  } catch (err) {
    console.error('Erreur envoyer-devis :', err);
    return res.status(500).json({ error: err.message || "Le devis n'a pas pu être envoyé." });
  }
}
