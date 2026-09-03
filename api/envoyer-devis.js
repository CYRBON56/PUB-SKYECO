// /api/envoyer-devis.js
// L'artisan a déjà uploadé le PDF du devis (dépôt direct dans le bucket Supabase
// Storage "skyeco-pro-media", même mécanisme que public/mes-elements.html) et
// nous transmet ici l'URL publique obtenue. On enregistre le devis sur la
// demande (lead) concernée, on génère un lien de signature à usage unique et
// on l'envoie par SMS au prospect.
//
// Réécrit le 03/09 pour ajouter des diagnostics clairs — la version précédente
// renvoyait "Demande introuvable" sans jamais dire POURQUOI la recherche
// échouait (mauvais projet Supabase visé par les variables d'environnement,
// variable absente, etc.), rendant le problème très difficile à localiser.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import crypto from 'crypto';

// Corrigé (03/09) : pointait vers app.skyeco.fr, un domaine jamais confirmé
// comme actif — aligné sur le domaine réellement utilisé partout ailleurs
// dans le site.
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { leadId, pdfUrl } = req.body || {};
  if (!leadId || !pdfUrl) {
    return res.status(400).json({ error: 'leadId ou pdfUrl manquant' });
  }

  // Vérification immédiate des variables d'environnement — au lieu de
  // laisser une requête Supabase mal formée échouer plus loin avec un
  // message trompeur ("Demande introuvable" alors que le vrai problème est
  // une variable absente ou mal ciblée sur Vercel).
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('envoyer-devis : variable manquante —', {
      SUPABASE_URL_present: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY_present: !!SERVICE_KEY,
    });
    return res.status(500).json({
      error: "Configuration serveur incomplète (variable d'environnement manquante) — contactez le support.",
    });
  }

  const supaHeaders = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Récupère le lead + le brouillon (nom de l'artisan, téléphone d'envoi dédié).
    const leadResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&select=id,draft_id,nom,prenom,telephone,devis_statut`,
      { headers: supaHeaders }
    );
    if (!leadResp.ok) {
      const detail = await leadResp.text().catch(() => '');
      // Une erreur HTTP ici (401/403 sur l'API elle-même, pas sur la ligne
      // recherchée) révèle presque toujours un problème de configuration
      // (mauvaise URL de projet, clé invalide) plutôt qu'une vraie donnée
      // manquante — d'où un message et un log distincts du cas "lead
      // introuvable" ci-dessous.
      console.error('envoyer-devis : requête Supabase (lead) en échec —', leadResp.status, detail);
      return res.status(502).json({ error: "Impossible d'interroger la base de données pour le moment." });
    }
    const leadRows = await leadResp.json();
    const lead = leadRows[0];
    if (!lead) {
      // Log volontairement détaillé (sans exposer la clé secrète) pour
      // pouvoir diagnostiquer en un coup d'œil dans les logs Vercel si ça se
      // reproduit : le host Supabase interrogé, et l'id recherché.
      console.error('envoyer-devis : aucun lead trouvé —', {
        leadId,
        supabaseHost: new URL(SUPABASE_URL).host,
      });
      return res.status(404).json({
        error: `Demande introuvable (id ${leadId}). Si cette demande existe bien dans le tableau de bord, vérifiez que SUPABASE_URL sur Vercel pointe vers le même projet Supabase que le reste du site.`,
      });
    }
    if (!lead.telephone) return res.status(400).json({ error: "Ce prospect n'a pas de numéro de téléphone enregistré." });
    if (lead.devis_statut === 'signe') {
      return res.status(409).json({ error: 'Ce devis a déjà été signé — impossible de le remplacer depuis cet écran.' });
    }

    const draftResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${lead.draft_id}&select=entreprise,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0] || {};
    const nomEntreprise = draft.entreprise || 'Votre artisan';

    // 2. Génère un jeton de signature à usage unique (aléatoire cryptographique,
    // contrairement au jeton simple Math.random utilisé pour le suivi de clics —
    // un devis engage une signature, on veut un jeton non devinable).
    const devisToken = crypto.randomBytes(24).toString('base64url');

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
      throw new Error(`Échec de l'enregistrement du devis : ${errData}`);
    }

    // 3. SMS avec le lien de signature.
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
