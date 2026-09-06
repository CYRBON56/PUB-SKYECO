// /api/relancer-devis.js
// Sécurité (06/09/2026) : même correctif que api/envoyer-devis.js — cet
// endpoint faisait confiance à un téléphone/prénom/devis_token fournis par
// le navigateur, sans aucune vérification de session, ce qui permettait
// d'envoyer un SMS de relance (au nom de l'artisan) vers n'importe quel
// numéro. Le lead est désormais relu en base avec la clé service_role et
// une session valide est exigée.
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

  const { leadId, token } = req.body || {};
  if (!leadId || !token) {
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
    const leadResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&select=id,prenom,telephone,devis_statut,devis_token,devis_nb_relances,draft_id`,
      { headers: supaHeaders }
    );
    if (!leadResp.ok) throw new Error('Lecture Supabase impossible : ' + (await leadResp.text()));
    const leadRows = await leadResp.json();
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ error: `Demande introuvable (id ${leadId}).` });

    if (!(await verifierToken(token, lead.draft_id))) {
      return res.status(401).json({ error: 'session_invalide' });
    }
    if (!lead.devis_token || lead.devis_statut === 'aucun') return res.status(400).json({ error: "Aucun devis n'a encore été envoyé pour ce prospect." });
    if (lead.devis_statut === 'signe') return res.status(400).json({ error: 'Ce devis est déjà signé — inutile de relancer.' });
    if (!lead.telephone) return res.status(400).json({ error: "Ce prospect n'a pas de numéro de téléphone enregistré." });

    const draftResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${lead.draft_id}&select=entreprise,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0] || {};
    const nomEntreprise = draft.entreprise || 'Votre artisan';

    const lien = `${SITE_BASE_URL}/signer-devis.html?t=${lead.devis_token}`;
    const prenomLead = (lead.prenom || '').trim();
    const texte = `Bonjour${prenomLead ? ' ' + prenomLead : ''}, petit rappel : ${nomEntreprise} attend votre retour sur le devis envoyé. Vous pouvez le consulter et le signer ici : ${lien}`;
    await envoyerSMS(lead.telephone, texte, draft.twilio_phone_number);

    const patchResp = await fetch(`${SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ devis_statut: 'relance', devis_nb_relances: (lead.devis_nb_relances || 0) + 1 }),
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
