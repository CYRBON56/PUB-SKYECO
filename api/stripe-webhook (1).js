// /api/stripe-webhook.js
// Écoute les événements Stripe liés aux abonnements. Le point important :
// "customer.subscription.deleted" ne se déclenche QUE quand la période déjà
// payée est réellement terminée (pas au moment du clic "annuler") — c'est
// exactement le "à la fin du mois la vitrine s'éteint" demandé.
//
// ⚠️ Configuration requise côté Stripe : Dashboard → Developers → Webhooks
// → Add endpoint → URL : https://pub-skyeco-23ue.vercel.app/api/stripe-webhook
// → Événements à écouter : customer.subscription.deleted, invoice.payment_failed, invoice.payment_succeeded, customer.subscription.updated
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET   (donné par Stripe à la création du endpoint ci-dessus)
//   SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Coordonnées internes RMS EcoSky, notifiées en cas d'échec de paiement.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'infos@ecosky.fr';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

async function notifierAdminSMS(texte) {
  if (!ADMIN_PHONE) return;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: ADMIN_PHONE, From: from, Body: texte }),
    });
  } catch (e) {
    console.error('Erreur notification SMS admin :', e);
  }
}

async function notifierAdminEmail(sujet, texte) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skyeco Pro <notifications@ecoskybyrms.fr>',
        to: [ADMIN_EMAIL],
        subject: sujet,
        html: `<p>${texte}</p>`,
      }),
    });
  } catch (e) {
    console.error('Erreur notification email admin :', e);
  }
}

export const config = {
  api: { bodyParser: false }, // Stripe a besoin du corps brut pour vérifier la signature
};

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Méthode non autorisée');
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  let event;
  try {
    const buf = await buffer(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(buf, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook Stripe invalide :', err.message);
    return res.status(400).send(`Webhook signature invalide : ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.deleted': {
        // La période payée est réellement terminée → on éteint la vitrine.
        const subscription = event.data.object;
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?stripe_subscription_id=eq.${subscription.id}`,
          {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({
              status: 'desactive',
              subscription_status: 'terminee',
            }),
          }
        );
        break;
      }

      case 'invoice.payment_succeeded': {
        // Un paiement a réussi — si un échec était en cours de suivi, on l'efface.
        const invoice = event.data.object;
        if (invoice.subscription) {
          await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?stripe_subscription_id=eq.${invoice.subscription}`,
            {
              method: 'PATCH',
              headers: { ...supaHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify({ subscription_status: 'active', echec_paiement_depuis_le: null }),
            }
          );
        }
        break;
      }

      case 'invoice.payment_failed': {
        // Un prélèvement mensuel a échoué (carte expirée, etc.) — on note le
        // statut sans éteindre immédiatement, Stripe retente automatiquement.
        const invoice = event.data.object;
        if (invoice.subscription) {
          // Récupère le nom de l'entreprise pour une notification utile.
          const draftResp = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?stripe_subscription_id=eq.${invoice.subscription}&select=entreprise,subscription_status,echec_paiement_depuis_le`,
            { headers: supaHeaders }
          );
          const draftRows = draftResp.ok ? await draftResp.json() : [];
          const draft = draftRows[0];
          const nomEntreprise = draft?.entreprise || 'un artisan';

          // On ne démarre le compteur des 2 mois que lors du PREMIER échec
          // consécutif — s'il y en avait déjà un en cours, on ne le réinitialise pas.
          const misesAJour = { subscription_status: 'paiement_echoue' };
          if (!draft?.echec_paiement_depuis_le) {
            misesAJour.echec_paiement_depuis_le = new Date().toISOString();
          }

          await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?stripe_subscription_id=eq.${invoice.subscription}`,
            {
              method: 'PATCH',
              headers: { ...supaHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify(misesAJour),
            }
          );

          const texteNotif = `Échec de prélèvement — ${nomEntreprise}. Abonnement Stripe : ${invoice.subscription}. Stripe va retenter automatiquement.`;
          await Promise.allSettled([
            notifierAdminSMS(texteNotif),
            notifierAdminEmail(`⚠️ Échec de paiement — ${nomEntreprise}`, texteNotif),
          ]);
        }
        break;
      }

      case 'customer.subscription.updated': {
        // Capture les changements de statut (ex: passage en "active" après
        // une période d'essai, ou réactivation après annulation programmée).
        const subscription = event.data.object;
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?stripe_subscription_id=eq.${subscription.id}`,
          {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ subscription_status: subscription.status }),
          }
        );
        break;
      }

      default:
        // Événement non géré, on l'ignore silencieusement.
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erreur traitement webhook Stripe :', err);
    return res.status(500).json({ error: err.message });
  }
}
