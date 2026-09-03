// /api/verifier-essais-a-programmer.js
// Tâche planifiée quotidienne. Pour chaque site en essai gratuit
// (status = 'essai') :
//   1. Si essai_gratuit_fin tombe dans les prochaines 24h et qu'aucun rappel
//      n'a encore été envoyé, envoie un SMS de rappel.
//   2. Si essai_gratuit_fin est déjà passée, bascule le statut en
//      'essai_expire' — ce statut bloque l'accès au tableau de bord
//      (mon-dashboard.html redirige automatiquement vers choisir-forfait.html
//      tant que l'artisan n'a pas réglé).
//
// Configuration requise dans vercel.json :
//   { "crons": [{ "path": "/api/verifier-essais-a-programmer", "schedule": "0 9 * * *" }] }
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   CRON_SECRET
//   SITE_BASE_URL (ex: https://www.skyeco.fr)
//   WINDSOR_API_KEY, GOOGLE_ADS_ACCOUNT_ID (coupure de la diffusion Google Ads à l'expiration)

const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://www.skyeco.fr';

// Même fonction que dans verifier-pauses-a-programmer.js — Twilio exige le
// format E.164 (+33...) pour l'API Messages, les numéros en base sont au
// format national français ("06 12 34 56 78"). Idempotente.
function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body, fromOverride) {
  if (!to) return;
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
    const draftsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?status=eq.essai&select=id,entreprise,telephone,twilio_phone_number,essai_gratuit_fin,essai_rappel_sms_envoye`,
      { headers: supaHeaders }
    );
    const drafts = await draftsResp.json();

    const rappelsEnvoyes = [];
    const essaisExpires = [];
    const maintenant = Date.now();

    for (const draft of drafts) {
      if (!draft.essai_gratuit_fin) continue;
      const finEssai = new Date(draft.essai_gratuit_fin).getTime();

      try {
        // 1. Essai déjà terminé -> on bloque la modification (pas l'accès en
        // lecture au dashboard, ni la vitrine, ni la diffusion Google Ads,
        // qui continue tant qu'il reste du budget — voir les blocages de
        // sauvegarde dans mon-dashboard.html / mes-elements.html).
        if (finEssai <= maintenant) {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'essai_expire' }),
          });
          essaisExpires.push(draft.entreprise);
          continue;
        }

        // 2. Essai qui se termine dans les prochaines 24h -> SMS de rappel,
        // une seule fois (marge de ~1 jour car le cron tourne 1x/jour).
        const dansMoinsDe24h = finEssai - maintenant <= 24 * 60 * 60 * 1000;
        if (dansMoinsDe24h && !draft.essai_rappel_sms_envoye && draft.telephone) {
          const lienOffre = `${SITE_BASE_URL}/choisir-forfait.html?id=${draft.id}`;
          const texte = `Bonjour, votre essai gratuit Skyeco Pro se termine demain. Pour continuer sans interruption, choisissez votre formule ici : ${lienOffre}`;

          await envoyerSMS(draft.telephone, texte, draft.twilio_phone_number);

          await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ essai_rappel_sms_envoye: true }),
          });

          rappelsEnvoyes.push(draft.entreprise);
        }
      } catch (err) {
        console.error(`Erreur pour ${draft.entreprise} :`, err);
      }
    }

    return res.status(200).json({
      success: true,
      essaisVerifies: drafts.length,
      rappelsEnvoyes,
      essaisExpires,
    });
  } catch (err) {
    console.error('Erreur verifier-essais-a-programmer :', err);
    return res.status(500).json({ error: err.message });
  }
}
