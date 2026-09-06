// /api/pause-subscription.js
// Met l'abonnement Stripe en pause pour 1 mois — aucun prélèvement pendant
// cette période, puis reprise AUTOMATIQUE (Stripe gère ça nativement via
// pause_collection.resumes_at, pas besoin de cron pour relancer).
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import Stripe from 'stripe';
import crypto from 'crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Sécurité (06/09/2026) : voir api/bloquer-creneau.js — ce endpoint mettait en
// pause IMMÉDIATEMENT le site ET l'abonnement Stripe d'un artisan sur simple
// présentation d'un draftId (non secret, publié dans les URLs Google Ads) —
// le pire cas trouvé dans l'audit : sabotage direct d'un site concurrent.
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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=stripe_subscription_id`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];

    if (!draft?.stripe_subscription_id) {
      return res.status(404).json({ error: 'Aucun abonnement actif trouvé pour ce site.' });
    }

    const dansUnMois = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await stripe.subscriptions.update(draft.stripe_subscription_id, {
      pause_collection: {
        behavior: 'void', // aucune facture générée pendant la pause
        resumes_at: dansUnMois,
      },
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ subscription_status: 'en_pause', status: 'en_pause' }),
    });

    return res.status(200).json({
      success: true,
      message: `Abonnement mis en pause dès maintenant — votre site affiche désormais une page de pause à vos visiteurs. Reprise automatique le ${new Date(dansUnMois * 1000).toLocaleDateString('fr-FR')} — ou à tout moment avant ça, depuis votre tableau de bord.`,
      reprisele: dansUnMois,
    });
  } catch (err) {
    console.error('Erreur pause-subscription :', err);
    return res.status(500).json({ error: err.message });
  }
}
