// /api/stripe-webhook.js
// Écoute les événements Stripe liés aux abonnements. Le point important :
// "customer.subscription.deleted" ne se déclenche QUE quand la période déjà
// payée est réellement terminée (pas au moment du clic "annuler") — c'est
// exactement le "à la fin du mois la vitrine s'éteint" demandé.
//
// ⚠️ Configuration requise côté Stripe : Dashboard → Developers → Webhooks
// → Add endpoint → URL : https://pub-skyeco-23ue.vercel.app/api/stripe-webhook
// → Événements à écouter : customer.subscription.deleted, invoice.payment_failed, invoice.payment_succeeded, customer.subscription.updated, checkout.session.completed
//   (ce dernier a été ajouté le 24/09/2026 pour la livraison automatique du
//   produit "Kit Pro Artisan BTP" — voir le cas checkout.session.completed
//   plus bas, qui ne traite QUE les sessions dont metadata.product =
//   'kit-pro-artisan-btp' pour ne jamais interférer avec les abonnements
//   Skyeco Pro existants, qui ne passent pas par cet événement)
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET   (donné par Stripe à la création du endpoint ci-dessus)
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY          (déjà utilisé ailleurs — envoi de l'email de livraison)

import Stripe from 'stripe';
import { blocCommentCaMarcheEstimateur } from './_lib/estimateur-btp-email.js';

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

// --- Notification ARTISAN après un prélèvement mensuel réussi (10/09/2026)
// Avant ce changement, un artisan prélevé de 39,90€/mois ne recevait RIEN :
// aucun email, aucun SMS, aucune facture — seul Cyrille était notifié, et
// uniquement en cas d'ÉCHEC de paiement. Corrigé ici.
//
// Choix technique : on ne réémet pas nous-mêmes une facture PDF pour cet
// abonnement — Stripe génère déjà une facture légale (hosted_invoice_url,
// PDF téléchargeable, avec la TVA si un taux de taxe est configuré sur le
// prix Stripe) à chaque prélèvement réussi. Il suffit d'activer l'envoi
// automatique de cette facture par email dans Stripe : Dashboard → Settings
// → Business → Customer emails → activer "Successful payments". Ce webhook
// ajoute seulement le SMS (que Stripe n'envoie jamais), avec le montant et
// le lien vers la facture Stripe.
//
// ⚠️ À vérifier une fois côté Stripe : le prix de l'abonnement (39,90€/mois)
// doit avoir un Tax Rate à 20% rattaché pour que la facture Stripe affiche
// la TVA — sinon la facture générée sera HT=TTC sans mention de taux.
async function envoyerSmsArtisan(telephone, texte) {
  if (!telephone) return;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    const digits = String(telephone).replace(/\D/g, '');
    const to = digits.startsWith('33') ? '+' + digits : (digits.startsWith('0') ? '+33' + digits.slice(1) : telephone);
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: texte }),
    });
  } catch (e) {
    console.error('Erreur SMS artisan (prélèvement réussi) :', e);
  }
}

// --- Livraison automatique du "Kit Pro Artisan BTP" (24/09/2026) ---------
// Après un paiement unique réussi (mode 'payment', metadata.product =
// 'kit-pro-artisan-btp' — voir api/create-checkout-kit-pro.js), on envoie
// immédiatement un email avec les liens de téléchargement des 3 fichiers.
// Ces fichiers sont servis en statique depuis /public sous un chemin non
// deviné (pas de vraie protection par jeton — cohérent avec un produit à
// 29€ ; à renforcer plus tard si besoin via des URLs signées Supabase
// Storage).
const KIT_PRO_BASE_URL = 'https://www.skyeco.fr/livraison-kpab-h8k2m9x1';
const KIT_PRO_FICHIERS = [
  { nom: 'Modèle de devis professionnel (.docx)', url: `${KIT_PRO_BASE_URL}/Modele-Devis-Pro-BTP.docx` },
  { nom: 'Kit visuels réseaux sociaux — format carré 1080×1080 (.pptx)', url: `${KIT_PRO_BASE_URL}/Kit-Visuels-Carre-1080x1080.pptx` },
  { nom: 'Kit visuels réseaux sociaux — format story 1080×1920 (.pptx)', url: `${KIT_PRO_BASE_URL}/Kit-Visuels-Story-1080x1920.pptx` },
];
// Application "Estimateur BTP" (calculateur de devis chantier, catalogue 123
// postes) — ce n'est pas un fichier à télécharger mais une page du site,
// installable sur l'écran d'accueil du téléphone (PWA) et utilisable hors
// connexion une fois ouverte une première fois. Ajoutée le 24/09/2026 :
// avant cette date le lien n'était envoyé nulle part après l'achat.
const KIT_PRO_LIEN_ESTIMATEUR = 'https://www.skyeco.fr/estimateur-btp.html';

// --- Confirmation d'achat "Estimateur BTP" (25/09/2026, achat unique) -----
// Envoyée dès que le paiement Stripe de 29,90€ HT est confirmé (voir le cas
// checkout.session.completed ci-dessous). Remplace l'ancien email de
// "bienvenue essai gratuit" envoyé auparavant par estimateur-btp-essai.js.
async function envoyerEmailAchatEstimateur(email) {
  const html = `
    <div style="font-family:Arial, sans-serif; color:#222; max-width:560px; margin:0 auto;">
      <h2 style="color:#1F3A5F;">Merci pour votre achat !</h2>
      <p>Votre accès à l'<strong>Estimateur BTP</strong> est activé — achat unique de 29,90€ HT, aucun abonnement, aucun prélèvement à venir.</p>
      <p style="margin:0 0 4px;"><a href="${KIT_PRO_LIEN_ESTIMATEUR}" style="color:#1F3A5F; font-weight:bold;">${KIT_PRO_LIEN_ESTIMATEUR}</a></p>
      <p style="margin:0 0 4px; font-size:13px; color:#666;">Ouvrez ce lien depuis votre téléphone, connectez-vous avec ce même email, puis ajoutez la page à votre écran d'accueil (bouton 📲 « Installer l'appli ») pour l'utiliser comme une application, même sans connexion internet sur un chantier isolé.</p>
      <div style="margin-top:24px; padding:18px; background:#F2F2F2; border-radius:10px;">
        ${blocCommentCaMarcheEstimateur()}
      </div>
      <p style="margin-top:24px; color:#666; font-size:13px;">Une question ? Répondez simplement à cet email.</p>
    </div>`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Estimateur BTP <notifications@ecoskybyrms.fr>',
      to: [email],
      subject: 'Merci pour votre achat — votre Estimateur BTP est prêt',
      html,
    }),
  });
  if (!resp.ok) {
    throw new Error('Resend a refusé l\'envoi : ' + (await resp.text()));
  }
}

async function envoyerEmailLivraisonKitPro(email) {
  const liensHtml = KIT_PRO_FICHIERS.map(
    (f) => `<li style="margin-bottom:10px;"><a href="${f.url}" style="color:#1F3A5F; font-weight:bold;">${f.nom}</a></li>`
  ).join('');
  const html = `
    <div style="font-family:Arial, sans-serif; color:#222; max-width:560px; margin:0 auto;">
      <h2 style="color:#1F3A5F;">Merci pour votre achat !</h2>
      <p>Voici vos fichiers du <strong>Kit Pro Artisan BTP</strong>, prêts à télécharger :</p>
      <ul style="padding-left:20px;">${liensHtml}</ul>
      <p style="margin-top:24px;">Chaque fichier s'ouvre avec Word / PowerPoint, ou peut être importé directement dans Canva (pour les visuels réseaux sociaux). Remplacez les textes entre crochets [ ] par vos informations et le tour est joué.</p>
      <div style="margin-top:24px; padding:18px; background:#F2F2F2; border-radius:10px;">
        <p style="margin:0 0 10px; font-weight:bold; color:#1F3A5F;">Bonus inclus : votre application de chiffrage sur chantier</p>
        <p style="margin:0 0 12px;">Ouvrez ce lien depuis votre téléphone pour chiffrer vos devis directement sur le chantier :</p>
        <p style="margin:0 0 10px;"><a href="${KIT_PRO_LIEN_ESTIMATEUR}" style="color:#1F3A5F; font-weight:bold;">${KIT_PRO_LIEN_ESTIMATEUR}</a></p>
        <p style="margin:0 0 4px; font-size:13px; color:#666;">Une fois la page ouverte, vous pouvez l'ajouter à votre écran d'accueil (menu du navigateur → « Ajouter à l'écran d'accueil », ou le bouton 📲 dans l'appli) pour l'utiliser comme une application, même sans connexion internet.</p>
        ${blocCommentCaMarcheEstimateur()}

      </div>
      <p style="margin-top:24px; color:#666; font-size:13px;">Un souci pour ouvrir ou retrouver vos fichiers ? Répondez simplement à cet email.</p>
    </div>`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Kit Pro Artisan BTP <notifications@ecoskybyrms.fr>',
      to: [email],
      subject: 'Vos fichiers — Kit Pro Artisan BTP',
      html,
    }),
  });
  if (!resp.ok) {
    throw new Error('Resend a refusé l\'envoi : ' + (await resp.text()));
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
        // Même chose côté abonnement "Estimateur BTP" (25/09/2026) — sans
        // effet si cet id ne correspond pas à un abonnement de ce produit
        // (aucune ligne ne matche dans ce cas, ce qui est normal pour tous
        // les autres abonnements Skyeco Pro).
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_acces?stripe_subscription_id=eq.${subscription.id}`,
          {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ abonnement_actif: false, updated_at: new Date().toISOString() }),
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

          // SMS à l'artisan (voir envoyerSmsArtisan ci-dessus) — uniquement
          // pour un montant réellement prélevé (0€ = simple renouvellement
          // d'essai gratuit, rien à notifier). La facture officielle part
          // par email directement via Stripe (à activer côté Dashboard).
          if (invoice.amount_paid > 0) {
            const draftResp = await fetch(
              `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?stripe_subscription_id=eq.${invoice.subscription}&select=entreprise,telephone`,
              { headers: supaHeaders }
            );
            const draftRows = draftResp.ok ? await draftResp.json() : [];
            const draft = draftRows[0];
            if (draft?.telephone) {
              const montant = (invoice.amount_paid / 100).toFixed(2).replace('.', ',');
              const texteSms = `Skyeco Ads — prélèvement de ${montant}€ effectué pour votre abonnement. Facture disponible par email` + (invoice.hosted_invoice_url ? ` ou ici : ${invoice.hosted_invoice_url}` : '.');
              await envoyerSmsArtisan(draft.telephone, texteSms);
            }
          }
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
        // Même chose côté abonnement "Estimateur BTP" (25/09/2026) — sans
        // effet si cet id ne correspond pas à un abonnement de ce produit.
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_acces?stripe_subscription_id=eq.${subscription.id}`,
          {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({
              abonnement_actif: subscription.status === 'active' || subscription.status === 'trialing',
              updated_at: new Date().toISOString(),
            }),
          }
        );
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object;

        // Achat unique "Estimateur BTP" (29,90€ HT, pas d'abonnement — revu
        // le 25/09/2026, il n'y a plus ni essai ni forfait récurrent) :
        // déverrouille l'accès dès ce paiement confirmé. Le retour sur la
        // page (success_url) revérifie aussi le statut de son côté
        // (estimateur-btp-statut.js) au cas où ce webhook arriverait après
        // que la personne soit revenue sur la page.
        if (session.metadata?.product === 'estimateur-btp' && session.mode === 'payment') {
          const email = (session.metadata?.email || session.customer_details?.email || session.customer_email || '').toLowerCase();
          if (email) {
            const existantResp = await fetch(
              `${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_acces?email=eq.${encodeURIComponent(email)}&select=abonnement_actif`,
              { headers: supaHeaders }
            );
            const existantRows = existantResp.ok ? await existantResp.json() : [];
            const avaitDejaAcces = existantRows[0]?.abonnement_actif === true;

            const champsAcces = {
              abonnement_actif: true,
              source: 'stripe',
              stripe_customer_id: session.customer || null,
              stripe_payment_intent: session.payment_intent || null,
              updated_at: new Date().toISOString(),
            };

            if (existantRows.length) {
              await fetch(`${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_acces?email=eq.${encodeURIComponent(email)}`, {
                method: 'PATCH',
                headers: { ...supaHeaders, Prefer: 'return=minimal' },
                body: JSON.stringify(champsAcces),
              });
            } else {
              await fetch(`${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_acces`, {
                method: 'POST',
                headers: { ...supaHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
                body: JSON.stringify({ email, ...champsAcces }),
              });
            }

            // Email de confirmation d'achat — uniquement au premier accès
            // accordé pour cet email (jamais renvoyé si l'accès était déjà
            // actif, par ex. sur un retry de webhook Stripe).
            if (!avaitDejaAcces) {
              try {
                await envoyerEmailAchatEstimateur(email);
              } catch (errEmail) {
                console.error('Erreur envoi email de confirmation — Estimateur BTP :', errEmail);
              }
            }
          }
        }

        // Ne traite ici QUE le paiement unique du Kit Pro Artisan BTP —
        // les abonnements Skyeco Pro (mode 'subscription') passent par
        // d'autres événements (invoice.payment_succeeded, etc.) ci-dessus
        // et ne portent pas cette metadata.
        if (session.metadata?.product === 'kit-pro-artisan-btp' && session.mode === 'payment') {
          const email = session.customer_details?.email || session.customer_email;

          // Stripe peut renvoyer le même événement plusieurs fois (retries).
          // On vérifie d'abord si cette session a déjà été traitée pour ne
          // jamais ré-envoyer l'email de livraison en double.
          const existeResp = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/kit_pro_commandes?stripe_session_id=eq.${session.id}&select=email_livraison_envoye`,
            { headers: supaHeaders }
          );
          const existeRows = existeResp.ok ? await existeResp.json() : [];
          const dejaLivre = existeRows[0]?.email_livraison_envoye === true;

          if (!existeRows.length) {
            // Première fois qu'on voit cette session : on enregistre la commande.
            await fetch(`${process.env.SUPABASE_URL}/rest/v1/kit_pro_commandes`, {
              method: 'POST',
              headers: { ...supaHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
              body: JSON.stringify({
                email,
                nom: session.customer_details?.name || null,
                stripe_session_id: session.id,
                stripe_payment_intent: session.payment_intent || null,
                montant_centimes: session.amount_total,
                statut: 'paye',
              }),
            });
          }

          if (email && !dejaLivre) {
            try {
              await envoyerEmailLivraisonKitPro(email);
              await fetch(
                `${process.env.SUPABASE_URL}/rest/v1/kit_pro_commandes?stripe_session_id=eq.${session.id}`,
                {
                  method: 'PATCH',
                  headers: { ...supaHeaders, Prefer: 'return=minimal' },
                  body: JSON.stringify({ email_livraison_envoye: true }),
                }
              );
            } catch (errEmail) {
              console.error('Erreur envoi email de livraison Kit Pro Artisan BTP :', errEmail);
              await fetch(
                `${process.env.SUPABASE_URL}/rest/v1/kit_pro_commandes?stripe_session_id=eq.${session.id}`,
                {
                  method: 'PATCH',
                  headers: { ...supaHeaders, Prefer: 'return=minimal' },
                  body: JSON.stringify({ email_livraison_erreur: String(errEmail.message || errEmail) }),
                }
              );
              // On notifie aussi l'admin pour un rattrapage manuel si l'email échoue.
              await Promise.allSettled([
                notifierAdminEmail(
                  '⚠️ Échec de livraison — Kit Pro Artisan BTP',
                  `Le paiement de ${email || 'un client'} a réussi (session ${session.id}) mais l'email de livraison a échoué : ${errEmail.message || errEmail}`
                ),
              ]);
            }
          }
        }
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
