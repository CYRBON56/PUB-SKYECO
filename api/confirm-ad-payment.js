// /api/confirm-ad-payment.js
// Vérifie que le paiement du budget publicitaire a bien été effectué, met à
// jour le budget du site, PUIS déclenche automatiquement la création de la
// campagne Google Ads (via create-google-ads-campaign.js) — c'est le "et la
// campagne se met en route" demandé : aucune étape manuelle après paiement.
//
// Le montant payé par l'artisan (session.metadata.budget) est TTC (ex. 100€).
// Skyeco IA Ads facture ce montant avec TVA à 20% (voir modèle de facturation),
// donc le budget RÉELLEMENT dépensé en diffusion publicitaire est le montant
// HT — ex. 100€ TTC -> 83,33€ HT de budget de campagne. C'est ce montant HT
// qui est stocké dans tarif_prix et utilisé pour créer la campagne Google Ads.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_SERVICE_ROLE_KEY
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const TAUX_TVA = 0.20;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
  const { sessionId, draftId } = req.body || {};
  if (!sessionId || !draftId) {
    return res.status(400).json({ error: 'sessionId ou draftId manquant' });
  }
  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Paiement non confirmé.' });
    }
    if (session.metadata?.draft_id !== draftId || session.metadata?.type !== 'ad_budget') {
      return res.status(400).json({ error: "Cette session ne correspond pas à cette campagne." });
    }
    const budgetTTC = parseFloat(session.metadata.budget);
    // Montant réellement disponible pour la diffusion, une fois la TVA retirée.
    const budgetHT = Math.round((budgetTTC / (1 + TAUX_TVA)) * 100) / 100;

    // 1. Met à jour le budget publicitaire du site (montant HT, pas le TTC payé).
    const updateResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          tarif_actif: true,
          tarif_prix: budgetHT,
          derniere_recharge_le: new Date().toISOString(),
          alerte_solde_bas_envoyee: false, // nouveau cycle de budget, l'alerte pourra repartir
        }),
      }
    );
    if (!updateResp.ok) {
      const errData = await updateResp.json().catch(() => ({}));
      console.error('Erreur mise à jour budget :', JSON.stringify(errData));
      return res.status(500).json({ error: 'Budget payé mais non enregistré — contactez le support.' });
    }
    // 2. Déclenche la création de la campagne Google Ads (appel interne serveur-à-serveur).
    const origin = req.headers.origin || `https://${req.headers.host}`;
    let campagne = null;
    try {
      const campagneResp = await fetch(`${origin}/api/create-google-ads-campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_id: draftId }),
      });
      const campagneData = await campagneResp.json();
      if (campagneResp.ok) {
        campagne = campagneData;
      } else {
        console.error('Campagne Google Ads non créée automatiquement :', JSON.stringify(campagneData));
      }
    } catch (campagneErr) {
      console.error('Erreur appel création campagne :', campagneErr);
    }
    return res.status(200).json({
      success: true,
      budgetPayeTTC: budgetTTC,
      budgetActif: budgetHT,
      campagneCreee: !!campagne?.success,
      campagneMessage: campagne?.success
        ? "Votre campagne a été créée en pause — elle sera vérifiée avant diffusion."
        : "Budget enregistré, mais la campagne n'a pas pu être créée automatiquement. Notre équipe s'en occupe.",
    });
  } catch (err) {
    console.error('Erreur confirm-ad-payment :', err);
    return res.status(500).json({ error: err.message });
  }
}
