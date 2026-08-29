// /api/verifier-pauses-a-programmer.js
// Tâche planifiée quotidienne. Pour chaque site ayant demandé une pause
// (pause_demandee = true), vérifie la date de fin de la période Stripe déjà
// payée. Si cette fin tombe dans 2 jours, envoie un SMS avec un lien à
// cliquer pour confirmer réellement la pause à ce moment-là.
//
// Configuration requise dans vercel.json :
//   { "crons": [{ "path": "/api/verifier-pauses-a-programmer", "schedule": "0 9 * * *" }] }
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   CRON_SECRET
//   SITE_BASE_URL (ex: https://pub-skyeco-23ue.vercel.app)

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://pub-skyeco-23ue.vercel.app';

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
    body: new URLSearchParams({ To: to, From: from, Body: body }),
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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?pause_demandee=eq.true&sms_pause_envoye=eq.false&select=id,entreprise,telephone,twilio_phone_number,stripe_subscription_id,pause_confirmation_token`,
      { headers: supaHeaders }
    );
    const drafts = await draftsResp.json();
    const smsEnvoyes = [];

    for (const draft of drafts) {
      if (!draft.stripe_subscription_id || !draft.telephone) continue;

      try {
        const subscription = await stripe.subscriptions.retrieve(draft.stripe_subscription_id);
        const finPeriode = subscription.current_period_end; // timestamp Unix
        const dansDeuxJours = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
        const margeUnJour = 24 * 60 * 60;

        // Déclenche si la fin de période tombe dans un créneau de ~24h
        // autour de J-2 (le cron tourne une fois par jour).
        if (Math.abs(finPeriode - dansDeuxJours) <= margeUnJour) {
          const lienConfirmation = `${SITE_BASE_URL}/api/confirmer-pause?id=${draft.id}&token=${draft.pause_confirmation_token}`;
          const dateFinLisible = new Date(finPeriode * 1000).toLocaleDateString('fr-FR');
          const texte = `Bonjour, votre période en cours se termine le ${dateFinLisible}. Vous avez demandé une pause : confirmez-la en cliquant ici, sinon votre abonnement continue normalement : ${lienConfirmation}`;

          await envoyerSMS(draft.telephone, texte, draft.twilio_phone_number);

          await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ sms_pause_envoye: true }),
          });

          smsEnvoyes.push(draft.entreprise);
        }
      } catch (err) {
        console.error(`Erreur pour ${draft.entreprise} :`, err);
      }
    }

    return res.status(200).json({ success: true, sitesVerifies: drafts.length, smsEnvoyes });
  } catch (err) {
    console.error('Erreur verifier-pauses-a-programmer :', err);
    return res.status(500).json({ error: err.message });
  }
}
