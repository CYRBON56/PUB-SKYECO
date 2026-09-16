// /api/cancel-subscription.js
// Résiliation d'abonnement demandée par l'artisan depuis campagne.html
// (bouton "Résilier mon abonnement"). Ce endpoint n'existait pas encore —
// le bouton, déjà câblé côté front (fetch('/api/cancel-subscription')),
// échouait donc systématiquement en prod (trouvé lors de l'audit du 06/09,
// confirmé de nouveau le 16/09).
//
// Comportement volontairement aligné sur ce qui est déjà promis à
// l'artisan (cgv.html, contrat.html) : "sans engagement, résiliable à
// tout moment, effet à la fin de la période déjà payée, aucun
// remboursement au prorata". On ne coupe donc JAMAIS l'accès
// immédiatement pour un abonnement Stripe réel — on programme
// l'annulation en fin de période (cancel_at_period_end: true) et on
// laisse le webhook existant (api/stripe-webhook.js,
// "customer.subscription.deleted") éteindre la vitrine quand la période
// payée se termine réellement, exactement comme le prévoyait déjà le
// commentaire en tête de ce fichier.
//
// Cas particulier essai gratuit (pas de stripe_subscription_id) : il n'y a
// pas de période déjà payée à honorer, donc on désactive tout de suite,
// même logique que côté reprise (api/reprendre-subscription.js) qui gère
// aussi ce cas sans passer par Stripe.
//
// ⚠️ IMPORTANT avant mise en prod : à tester en mode Stripe TEST sur un
// abonnement de test (pas un vrai artisan payant) avant tout déploiement,
// comme pour toute modification touchant à la facturation réelle.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import Stripe from 'stripe';
import crypto from 'crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Même vérification de jeton que pause-subscription.js / reprendre-subscription.js
// (dupliquée à l'identique par cohérence avec le reste du repo, qui n'a pas
// de lib partagée pour ça).
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ error: 'session_invalide' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=stripe_subscription_id,subscription_status`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];

    if (!draft) {
      return res.status(404).json({ error: 'Site introuvable.' });
    }

    // Déjà résilié ou en cours de résiliation — évite un appel Stripe inutile
    // et un message trompeur si l'artisan clique deux fois.
    if (draft.subscription_status === 'resiliation_programmee') {
      return res.status(200).json({
        success: true,
        message: 'Votre résiliation est déjà programmée — votre vitrine reste active jusqu\'à la fin de la période déjà payée.',
      });
    }

    if (!draft.stripe_subscription_id) {
      // Essai gratuit : pas de période payée à honorer, on coupe tout de suite.
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'desactive', subscription_status: 'annule' }),
      });
      return res.status(200).json({ success: true, message: 'Votre essai gratuit a été résilié — votre vitrine est désactivée.' });
    }

    // Abonnement Stripe réel : on programme l'annulation en fin de période,
    // on ne coupe rien tout de suite (voir le commentaire en tête de fichier).
    const subscription = await stripe.subscriptions.update(draft.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ subscription_status: 'resiliation_programmee' }),
    });

    const dateFin = new Date(subscription.current_period_end * 1000).toLocaleDateString('fr-FR');

    return res.status(200).json({
      success: true,
      message: `Résiliation confirmée. Votre vitrine reste active jusqu'au ${dateFin} (fin de la période déjà payée), puis sera désactivée automatiquement — aucun autre prélèvement n'aura lieu après cette date.`,
      finPeriode: subscription.current_period_end,
    });
  } catch (err) {
    console.error('Erreur cancel-subscription :', err);
    return res.status(500).json({ error: err.message });
  }
}
