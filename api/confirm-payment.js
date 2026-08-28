// /api/confirm-payment.js
// Vérifie côté serveur qu'une session Stripe d'ABONNEMENT a bien été activée,
// puis passe le brouillon correspondant en statut "published" dans Supabase,
// avec le suivi de l'abonnement (id, statut) pour la suite (renouvellement,
// annulation — voir le webhook Stripe à ajouter en V2 pour ça).
//
// Provisionne aussi un NUMÉRO TWILIO DÉDIÉ à cet artisan — un numéro par
// client, pas un numéro partagé, pour isoler la réputation d'envoi SMS de
// chaque artisan (si l'un d'eux génère des plaintes/désabonnements en masse,
// ça n'affecte pas les autres clients).
//
// ⚠️ Note réglementaire : la location de numéros FRANÇAIS pour du SMS
// commercial peut nécessiter un dossier de conformité ("regulatory bundle")
// côté Twilio — à vérifier. Ce code tente l'achat automatique ; s'il échoue
// pour raison réglementaire, le site reste fonctionnel sur le numéro partagé
// (TWILIO_FROM_NUMBER) en repli, sans bloquer la publication.
//
// Variables d'environnement requises (à définir dans Vercel, jamais dans le code) :
//   STRIPE_SECRET_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  'https://wklddwumirkdjkbxvzyj.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function provisionnerNumeroTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');

  try {
    // 1. Cherche un numéro français disponible.
    const rechercheResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/FR/Local.json?SmsEnabled=true&PageSize=1`,
      { headers: { Authorization: auth } }
    );
    const rechercheData = await rechercheResp.json();
    const numeroDisponible = rechercheData?.available_phone_numbers?.[0]?.phone_number;

    if (!numeroDisponible) {
      console.warn('Aucun numéro français disponible chez Twilio pour le moment.');
      return null;
    }

    // 2. Achète ce numéro.
    const achatResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ PhoneNumber: numeroDisponible }),
      }
    );
    const achatData = await achatResp.json();

    if (!achatResp.ok) {
      // Échec probable pour raison réglementaire (bundle de conformité manquant) —
      // on ne bloque pas la publication du site pour autant.
      console.warn('Achat du numéro Twilio échoué (probablement réglementaire) :', JSON.stringify(achatData));
      return null;
    }

    return achatData.phone_number;
  } catch (err) {
    console.error('Erreur provisionnement numéro Twilio :', err);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { sessionId, draftId } = req.body || {};
  if (!sessionId || !draftId) {
    return res.status(400).json({ error: 'sessionId ou draftId manquant' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Paiement non confirmé.' });
    }
    if (session.metadata?.draft_id !== draftId) {
      return res.status(400).json({ error: "Cette session ne correspond pas à cet aperçu." });
    }
    if (session.mode !== 'subscription' || !session.subscription) {
      return res.status(400).json({ error: "Cette session n'est pas un abonnement valide." });
    }

    const subscription = session.subscription;

    // Ne provisionne un numéro que si ce site n'en a pas déjà un (évite d'en
    // racheter un à chaque renouvellement de session).
    const { data: draftExistant } = await supabaseAdmin
      .from('skyeco_pro_vitrine_drafts')
      .select('twilio_phone_number')
      .eq('id', draftId)
      .single();

    const numeroDedie = draftExistant?.twilio_phone_number || await provisionnerNumeroTwilio();

    const { error } = await supabaseAdmin
      .from('skyeco_pro_vitrine_drafts')
      .update({
        status: 'published',
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status, // 'active', 'trialing', etc.
        forfait: parseInt(session.metadata?.plan || '1', 10),
        twilio_phone_number: numeroDedie, // null si le provisionnement a échoué — repli sur le numéro partagé
        updated_at: new Date().toISOString(),
      })
      .eq('id', draftId);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      subscriptionStatus: subscription.status,
      numeroDedieProvisionne: !!numeroDedie,
    });
  } catch (err) {
    console.error('Erreur confirmation paiement :', err);
    return res.status(500).json({ error: err.message });
  }
}
