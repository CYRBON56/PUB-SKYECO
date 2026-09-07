// /api/get-campaign-spend.js
// Interroge la vraie dépense/clics Google Ads via l'API Windsor.ai, et calcule
// la consommation ajustée du solde artisan (chaque € Google = 2€ du solde,
// puisque la commission de service est de 50%). Envoie un SMS d'alerte à
// l'artisan la première fois que son solde restant passe à 50€ ou moins, et
// met en pause automatiquement SA campagne (uniquement la sienne) dès que le
// solde atteint 0€ — même garde-fou que le cron verifier-soldes-bas.js, mais
// déclenché ici immédiatement dès que quelqu'un ouvre ce dashboard précis
// (03/09), en complément du passage quotidien du cron.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   GOOGLE_ADS_ACCOUNT_ID

import crypto from 'crypto';

// Sécurité (06/09/2026) : voir api/bloquer-creneau.js — ce endpoint révélait
// le coût réel, le budget restant et les clics de la campagne (données
// commerciales sensibles) sur simple présentation d'un draft_id (non secret).
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
  } catch (e) {
    return false;
  }
}

const TAUX_COMMISSION = 0.50; // doit rester synchronisé avec les autres fichiers
const FACTEUR_CONSOMMATION = 1 / (1 - TAUX_COMMISSION);
const SEUIL_ALERTE_SOLDE = 50; // €

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';

// Windsor.ai attend l'identifiant de compte Google Ads AVEC tirets (format
// XXX-XXX-XXXX) — bug corrigé le 03/09, voir create-google-ads-campaign.js :
// erreur réelle "Account 7849903984 is not available. The configured
// accounts are: 784-990-3984."
function formaterCompteGoogleAds(id) {
  const chiffres = String(id || '').replace(/[^0-9]/g, '');
  if (chiffres.length !== 10) return String(id || '').trim();
  return `${chiffres.slice(0, 3)}-${chiffres.slice(3, 6)}-${chiffres.slice(6)}`;
}

async function executerActionGoogleAds(action, params) {
  const accountId = formaterCompteGoogleAds(process.env.GOOGLE_ADS_ACCOUNT_ID);
  const resp = await fetch(`${WINDSOR_BASE}/actions?api_key=${process.env.WINDSOR_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: accountId, action, params }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Action Windsor.ai "${action}" échouée : ${JSON.stringify(data)}`);
  return data;
}

// Twilio exige un numero au format E.164 (+33...) pour le parametre "To" des
// SMS envoyes via l'API Messages (contrairement a Twilio Verify, deja converti
// ailleurs). Les numeros stockes en base viennent du formulaire d'inscription
// au format national francais ("06 12 34 56 78"), jamais convertis avant ces
// envois -> Twilio les rejetait silencieusement (erreur 21211, capturee par le
// try/catch), d'ou les echecs d'envoi. Idempotent : ne change rien a un numero
// deja au format E.164.
function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body, fromOverride) {
  if (!to) return;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = fromOverride || process.env.TWILIO_FROM_NUMBER;
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
    });
  } catch (e) {
    console.error('Erreur envoi SMS alerte solde :', e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draft_id, token } = req.body || {};
  if (!draft_id || !token) {
    return res.status(401).json({ error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draft_id))) {
    return res.status(401).json({ error: 'session_invalide' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=entreprise,telephone,twilio_phone_number,google_ads_campaign_resource,tarif_prix,derniere_recharge_le,alerte_solde_bas_envoyee,campagne_diffusion_pausee,campagne_pausee_budget_epuise,est_demo`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];

    // Fiche de démonstration (07/09) : jamais de vraie campagne Google Ads
    // liée — chiffres fictifs mais réalistes, pour filmer le dashboard sans
    // jamais appeler Windsor.ai/Google Ads pour cette fiche.
    if (draft?.est_demo) {
      return res.status(200).json({
        success: true, campagneExiste: true,
        clics: 87, coutReelGoogleEuros: 62.5, consommationAjustee: 125,
        budgetPaye: 150, budgetRestant: 25, pourcentageConsomme: 83,
        diffusionPausee: false,
      });
    }

    if (!draft?.google_ads_campaign_resource) {
      return res.status(200).json({ success: true, campagneExiste: false });
    }

    // Lecture des vraies données Google Ads (clics + coût) sur la campagne,
    // filtrée depuis la dernière recharge de budget.
    const dateDepart = draft.derniere_recharge_le
      ? new Date(draft.derniere_recharge_le).toISOString().slice(0, 10)
      : undefined;

    const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', draft.google_ads_campaign_resource]]));
    let url = `https://connectors.windsor.ai/google_ads?api_key=${process.env.WINDSOR_API_KEY}&fields=clicks,cost&filter=${filtre}`;
    url += dateDepart ? `&date_from=${dateDepart}` : `&date_preset=last_30d`;

    const windsorResp = await fetch(url);
    const windsorData = await windsorResp.json();
    if (!windsorResp.ok) throw new Error(`Windsor.ai a répondu une erreur : ${JSON.stringify(windsorData)}`);

    const lignes = windsorData.data || [];
    const clics = lignes.reduce((acc, l) => acc + (Number(l.clicks) || 0), 0);
    const coutReelEuros = lignes.reduce((acc, l) => acc + (Number(l.cost) || 0), 0);

    const consommationAjustee = +(coutReelEuros * FACTEUR_CONSOMMATION).toFixed(2);
    const budgetPaye = draft.tarif_prix || 0;
    const budgetRestant = +Math.max(0, budgetPaye - consommationAjustee).toFixed(2);
    const pourcentageConsomme = budgetPaye > 0 ? Math.min(100, Math.round((consommationAjustee / budgetPaye) * 100)) : 0;

    let diffusionPausee = !!draft.campagne_diffusion_pausee;

    if (budgetRestant <= 0 && budgetPaye > 0 && !draft.campagne_pausee_budget_epuise) {
      // Solde épuisé — on met en pause CETTE campagne précisément (même
      // garde-fou que verifier-soldes-bas.js) : les autres sites du compte
      // ne sont pas concernés, ils ont chacun leur propre campagne.
      try {
        await executerActionGoogleAds('pause_campaign', { campaign_id: draft.google_ads_campaign_resource });
        const texteEpuise = `Bonjour, votre budget publicitaire Skyeco Ads est épuisé — votre campagne Google Ads a été mise en pause automatiquement. Rechargez depuis votre tableau de bord pour relancer la diffusion.`;
        await envoyerSMS(draft.telephone, texteEpuise, draft.twilio_phone_number);
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
          method: 'PATCH',
          headers: { ...supaHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ campagne_diffusion_pausee: true, campagne_pausee_budget_epuise: true }),
        });
        diffusionPausee = true;
      } catch (pauseErr) {
        console.error('Erreur mise en pause automatique (solde épuisé) :', pauseErr);
      }
    } else if (budgetRestant <= SEUIL_ALERTE_SOLDE && budgetPaye > 0 && !draft.alerte_solde_bas_envoyee) {
      // Alerte solde bas — envoyée une seule fois par cycle de recharge, dès
      // que le seuil est franchi. Remise à zéro par confirm-ad-payment.js à
      // chaque nouvelle recharge.
      const texteAlerte = `Bonjour, il vous reste environ ${budgetRestant} € de budget publicitaire Skyeco Ads. Pensez à recharger pour continuer à recevoir des demandes.`;
      await envoyerSMS(draft.telephone, texteAlerte, draft.twilio_phone_number);
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ alerte_solde_bas_envoyee: true }),
      });
    }

    return res.status(200).json({
      success: true,
      campagneExiste: true,
      clics,
      coutReelGoogleEuros: +coutReelEuros.toFixed(2),
      consommationAjustee,
      budgetPaye,
      budgetRestant,
      pourcentageConsomme,
      diffusionPausee,
    });
  } catch (err) {
    console.error('Erreur get-campaign-spend (Windsor.ai) :', err);
    return res.status(500).json({ error: err.message });
  }
}
