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
// 12/09/2026 : ce paiement du budget Ads démarre désormais aussi
// automatiquement l'essai d'1 mois du FORFAIT (abonnement Skyeco Pro,
// distinct du budget Ads) si aucun essai/abonnement n'est déjà en cours —
// réutilise le même statut ('essai' + essai_gratuit_fin à J+30) que
// demarrer-essai-gratuit.js, donc le rappel SMS/email à J-1 et le passage
// en 'essai_expire' déjà gérés par api/verifier-essais-a-programmer.js
// s'appliquent sans rien à changer côté planification. Ne touche pas au
// statut si un essai est déjà en cours, déjà expiré, ou si un abonnement
// payant existe déjà — pour ne jamais écraser une situation plus avancée.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_SERVICE_ROLE_KEY
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const TAUX_TVA = 0.20;
const DUREE_ESSAI_JOURS = 30;

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
    // Facture Stripe générée automatiquement (invoice_creation activé côté
    // create-ad-budget-checkout.js) — on récupère son lien pour l'afficher
    // à l'artisan juste après paiement et, si dispo, le PDF téléchargeable.
    let factureUrl = null;
    let facturePdfUrl = null;
    if (session.invoice) {
      try {
        const invoiceStripe = await stripe.invoices.retrieve(session.invoice);
        factureUrl = invoiceStripe.hosted_invoice_url || null;
        facturePdfUrl = invoiceStripe.invoice_pdf || null;
      } catch (factureErr) {
        console.error('Erreur récupération facture Stripe :', factureErr);
      }
    }
    const budgetTTC = parseFloat(session.metadata.budget);
    // Montant réellement disponible pour la diffusion, une fois la TVA retirée.
    const budgetHT = Math.round((budgetTTC / (1 + TAUX_TVA)) * 100) / 100;

    // Statut actuel du site — sert à décider si on démarre l'essai du
    // forfait (voir plus bas) sans écraser une situation déjà plus avancée
    // (abonnement payant actif, essai déjà en cours ou déjà expiré).
    let statutActuel = null;
    try {
      const statutResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=status`,
        { headers: supaHeaders }
      );
      const statutRows = await statutResp.json();
      statutActuel = statutRows[0]?.status || null;
    } catch (statutErr) {
      console.error('Erreur lecture statut avant paiement Ads :', statutErr);
    }

    // 1. Met à jour le budget publicitaire du site (montant HT, pas le TTC payé).
    const champsAMettreAJour = {
      tarif_actif: true,
      tarif_prix: budgetHT,
      derniere_recharge_le: new Date().toISOString(),
      alerte_solde_bas_envoyee: false, // nouveau cycle de budget, l'alerte pourra repartir
    };

    // Démarre l'essai du forfait UNIQUEMENT si le site n'a ni essai en
    // cours, ni essai déjà expiré, ni statut plus avancé (published,
    // en_pause) — c'est-à-dire seulement pour un tout premier passage.
    const statutsANePasToucher = ['essai', 'essai_expire', 'published', 'en_pause'];
    if (!statutsANePasToucher.includes(statutActuel)) {
      champsAMettreAJour.status = 'essai';
      champsAMettreAJour.essai_gratuit_fin = new Date(Date.now() + DUREE_ESSAI_JOURS * 24 * 60 * 60 * 1000).toISOString();
    }

    const updateResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(champsAMettreAJour),
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
      factureUrl,
      facturePdfUrl,
    });
  } catch (err) {
    console.error('Erreur confirm-ad-payment :', err);
    return res.status(500).json({ error: err.message });
  }
}
