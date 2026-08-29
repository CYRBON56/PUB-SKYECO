// /api/verifier-soldes-bas.js
// Tâche planifiée (Vercel Cron) qui parcourt TOUS les sites avec une campagne
// active et un budget en cours, calcule leur solde restant réel via
// Windsor.ai, et envoie un SMS d'alerte si le solde est à 50€ ou moins —
// sans dépendre d'une visite du dashboard par l'artisan ou par toi.
//
// Configuration requise dans vercel.json :
//   { "crons": [{ "path": "/api/verifier-soldes-bas", "schedule": "0 8 * * *" }] }
//   (tous les jours à 8h — ajuste l'heure si besoin)
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   CRON_SECRET (protège l'endpoint contre les appels non autorisés)

const TAUX_COMMISSION = 0.50; // doit rester synchronisé avec get-campaign-spend.js
const FACTEUR_CONSOMMATION = 1 / (1 - TAUX_COMMISSION);
const SEUIL_ALERTE_SOLDE = 50; // €

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
    // Tous les sites avec une campagne active, un budget en cours, et dont
    // l'alerte n'a pas déjà été envoyée pour ce cycle.
    const draftsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?google_ads_campaign_resource=not.is.null&tarif_prix=gt.0&alerte_solde_bas_envoyee=eq.false&select=id,entreprise,telephone,twilio_phone_number,google_ads_campaign_resource,tarif_prix,derniere_recharge_le`,
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

        if (budgetRestant <= SEUIL_ALERTE_SOLDE) {
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
      alertesEnvoyees: resultats.length,
      details: resultats,
    });
  } catch (err) {
    console.error('Erreur verifier-soldes-bas :', err);
    return res.status(500).json({ error: err.message });
  }
}
