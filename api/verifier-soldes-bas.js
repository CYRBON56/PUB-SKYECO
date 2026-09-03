// /api/verifier-soldes-bas.js
// Tâche planifiée (Vercel Cron) qui parcourt TOUS les sites avec une campagne
// active et un budget en cours, calcule leur solde restant réel via
// Windsor.ai, et :
//   1. met en pause AUTOMATIQUEMENT (sur Google Ads, via Windsor.ai) la
//      diffusion du site dont le solde tombe à 0€ ou moins — et UNIQUEMENT
//      celui-là, jamais les autres sites/clients (chacun a sa propre
//      campagne sur le même compte Google Ads partagé, voir
//      create-google-ads-campaign.js) ;
//   2. envoie un SMS d'alerte (comme avant) dès que le solde passe à 50€ ou
//      moins, tant qu'il n'est pas encore à 0.
// Conçu pour tenir à l'échelle de centaines de clients sans intervention
// manuelle — sans dépendre d'une visite du dashboard par l'artisan ou par
// toi. La diffusion reprend automatiquement à la prochaine recharge de
// budget (voir create-google-ads-campaign.js, appelé par
// confirm-ad-payment.js) — SAUF si Cyrille avait entre-temps mis le site en
// pause lui-même pour une autre raison (pause-campagne-ads.js), auquel cas
// seule une reprise manuelle de sa part relance la diffusion.
//
// Configuration requise dans vercel.json (03/09 : resserré à 15 min — plan
// Vercel Pro actif, confirmé par Cyrille — au lieu d'1x/jour) :
//   { "crons": [{ "path": "/api/verifier-soldes-bas", "schedule": "*/15 * * * *" }] }
//   Entre deux passages du cron, un site à 0€ continue de fait à consommer
//   du vrai budget Google Ads réel jusqu'au prochain passage (max 15 min de
//   dépassement possible désormais, sauf si le dashboard du site est ouvert
//   entre-temps — voir get-campaign-spend.js, qui coupe immédiatement).
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   CRON_SECRET (protège l'endpoint contre les appels non autorisés)
//   GOOGLE_ADS_ACCOUNT_ID

const TAUX_COMMISSION = 0.50; // doit rester synchronisé avec get-campaign-spend.js
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
    console.error('Erreur envoi SMS alerte solde (cron) :', e);
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Tous les sites avec une campagne active et un budget en cours — on ne
    // filtre plus sur "alerte pas encore envoyée" ici : il faut re-vérifier
    // CHAQUE site à CHAQUE passage pour détecter le moment où son solde
    // franchit 0€, même après que l'alerte à 50€ a déjà été envoyée.
    const draftsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?google_ads_campaign_resource=not.is.null&tarif_prix=gt.0&select=id,entreprise,telephone,twilio_phone_number,google_ads_campaign_resource,tarif_prix,derniere_recharge_le,alerte_solde_bas_envoyee,campagne_pausee_budget_epuise`,
      { headers: supaHeaders }
    );
    if (!draftsResp.ok) throw new Error('Impossible de lire les sites à vérifier.');
    const drafts = await draftsResp.json();

    const resultats = [];

    for (const draft of drafts) {
      try {
        const dateDepart = draft.derniere_recharge_le
          ? new Date(draft.derniere_recharge_le).toISOString().slice(0, 10)
          : undefined;

        const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', draft.google_ads_campaign_resource]]));
        let url = `https://connectors.windsor.ai/google_ads?api_key=${process.env.WINDSOR_API_KEY}&fields=clicks,cost&filter=${filtre}`;
        url += dateDepart ? `&date_from=${dateDepart}` : `&date_preset=last_30d`;

        const windsorResp = await fetch(url);
        const windsorData = await windsorResp.json();
        if (!windsorResp.ok) {
          console.error(`Windsor.ai erreur pour ${draft.entreprise} :`, JSON.stringify(windsorData));
          continue;
        }

        const lignes = windsorData.data || [];
        const coutReelEuros = lignes.reduce((acc, l) => acc + (Number(l.cost) || 0), 0);
        const consommationAjustee = coutReelEuros * FACTEUR_CONSOMMATION;
        const budgetRestant = +Math.max(0, draft.tarif_prix - consommationAjustee).toFixed(2);

        if (budgetRestant <= 0) {
          // Solde épuisé : on met en pause CE site précisément, sans toucher
          // aux autres — sauf s'il l'est déjà (pause déjà appliquée par un
          // passage précédent du cron, ou par Cyrille lui-même).
          if (!draft.campagne_pausee_budget_epuise) {
            await executerActionGoogleAds('pause_campaign', { campaign_id: draft.google_ads_campaign_resource });

            const texteEpuise = `Bonjour, votre budget publicitaire Skyeco Ads est épuisé — votre campagne Google Ads a été mise en pause automatiquement. Rechargez depuis votre tableau de bord pour relancer la diffusion.`;
            await envoyerSMS(draft.telephone, texteEpuise, draft.twilio_phone_number);

            await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
              method: 'PATCH',
              headers: { ...supaHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify({ campagne_diffusion_pausee: true, campagne_pausee_budget_epuise: true }),
            });

            resultats.push({ entreprise: draft.entreprise, budgetRestant, misEnPause: true });
          }
        } else if (budgetRestant <= SEUIL_ALERTE_SOLDE && !draft.alerte_solde_bas_envoyee) {
          const texteAlerte = `Bonjour, il vous reste environ ${budgetRestant} € de budget publicitaire Skyeco Ads. Pensez à recharger pour continuer à recevoir des demandes.`;
          await envoyerSMS(draft.telephone, texteAlerte, draft.twilio_phone_number);

          await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ alerte_solde_bas_envoyee: true }),
          });

          resultats.push({ entreprise: draft.entreprise, budgetRestant, alerteEnvoyee: true });
        }
      } catch (err) {
        console.error(`Erreur vérification solde pour ${draft.entreprise} :`, err);
      }
    }

    return res.status(200).json({
      success: true,
      sitesVerifies: drafts.length,
      actionsPrises: resultats.length, // alertes SMS à 50€ + mises en pause automatiques à 0€
      details: resultats,
    });
  } catch (err) {
    console.error('Erreur verifier-soldes-bas :', err);
    return res.status(500).json({ error: err.message });
  }
}
