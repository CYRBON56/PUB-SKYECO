// /api/reprendre-subscription.js
// Reprend manuellement un abonnement mis en pause, sans attendre les 30
// jours de reprise automatique — et repasse le site en ligne.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import Stripe from 'stripe';
import crypto from 'crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Sécurité (06/09/2026) : voir api/bloquer-creneau.js — ce endpoint pouvait
// être appelé sur simple présentation d'un draftId (non secret). Moins grave
// dans ce sens (repasser un site en ligne) que pause-subscription.js, mais
// même principe : toute action qui touche à l'abonnement doit être protégée.
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
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ success: false, error: 'non_authentifie' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
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
    const rows = await draftResp.json();
    const draft = rows[0];

    if (!draft?.stripe_subscription_id) {
      // Compte en essai gratuit (pas d'abonnement Stripe réel) — on reprend
      // directement en base, sans passer par Stripe. Ajouté le 03/09 :
      // auparavant, un essai gratuit qui se mettait en pause ne pouvait
      // ensuite plus jamais être repris ("Aucun abonnement trouvé").
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ subscription_status: 'active', status: 'essai' }),
      });
      return res.status(200).json({ success: true, message: 'Diffusion reprise.' });
    }

    await stripe.subscriptions.update(draft.stripe_subscription_id, {
      pause_collection: '', // retire la pause côté Stripe
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'published', subscription_status: 'active' }),
    });

    return res.status(200).json({ success: true, message: 'Abonnement repris. Votre site est de nouveau en ligne.' });
  } catch (err) {
    console.error('Erreur reprendre-subscription :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
