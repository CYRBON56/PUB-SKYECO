// /api/create-checkout-session.js
// Crée une session Stripe pour ABONNER un artisan à Skyeco Pro (récurrent
// mensuel), et non plus un paiement unique de mise en ligne.
// Variables d'environnement requises (à définir dans Vercel, jamais dans le code) :
//   STRIPE_SECRET_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Forfait unique Skyeco Pro (31/08) — prix HT. La TVA française (20%) est
// ajoutée au moment du paiement, sur le montant réellement facturé via
// Stripe. Auparavant 4 forfaits (1 à 4) ; seul l'ancien forfait 3 (le plus
// complet) reste proposé aux nouveaux clients. L'id "3" et la structure en
// map sont conservés pour rester cohérents avec les metadata Stripe déjà
// enregistrées sur les abonnements existants d'anciens forfaits (1/2/4),
// qui ne sont pas concernés par ce changement et ne passent plus par ce
// endpoint de toute façon.
const TAUX_TVA = 0.20;
const FORFAITS = {
  3: { nom: 'Skyeco Pro — Vitrine + Dashboard + Relances & devis signés', centimesHT: 7990 },
};

// Remise de lancement 1ère année (31/08) : offre permanente pour tout
// nouveau client — 39,90€ HT/mois pendant 12 mois (soit 40€ HT/mois de
// remise), puis retour automatique à 79,90€ HT/mois à partir du 13e mois.
// Gérée nativement par un coupon Stripe "repeating" sur 12 mois : Stripe
// applique et retire la remise tout seul, aucune action de notre part au
// bout d'un an. Le montant du coupon est exprimé en TTC (4800 centimes,
// soit 48€ TTC = 40€ HT) car nos prix n'utilisent pas le calcul de taxe
// Stripe — la TVA est déjà intégrée dans unit_amount ci-dessous.
const COUPON_REMISE_ID = 'skyeco-remise-1ere-annee';
const REMISE_DUREE_MOIS = 12;
const REMISE_MONTANT_CENTIMES_TTC = 4800;

async function assurerCouponRemise() {
  try {
    await stripe.coupons.retrieve(COUPON_REMISE_ID);
  } catch (e) {
    // N'existe pas encore (1er appel) : on le crée une fois pour toutes.
    // Si deux requêtes arrivent en même temps et que la création échoue
    // parce qu'il vient d'être créé par l'autre, on l'ignore : le coupon
    // existe de toute façon.
    try {
      await stripe.coupons.create({
        id: COUPON_REMISE_ID,
        duration: 'repeating',
        duration_in_months: REMISE_DUREE_MOIS,
        amount_off: REMISE_MONTANT_CENTIMES_TTC,
        currency: 'eur',
        name: 'Remise 1ère année Skyeco Pro',
      });
    } catch (e2) { /* déjà créé entre-temps, ou erreur transitoire : pas bloquant */ }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draftId, entreprise, plan } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ error: 'draftId manquant' });
  }

  // Vérification serveur (pas seulement côté page) : impossible de payer
  // tant que Cyrille n'a pas validé le site depuis mes-artisans.html — ce
  // même contrôle protège aussi api/demarrer-essai-gratuit.js. Empêche un
  // contournement en appelant directement cet endpoint.
  try {
    const verifResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=site_valide`,
      { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const verifRows = await verifResp.json();
    if (!verifRows[0]?.site_valide) {
      return res.status(403).json({ error: "Ce site n'a pas encore été validé — demandez la validation depuis votre page." });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Impossible de vérifier le statut du site pour le moment.' });
  }

  const forfait = FORFAITS[plan] || FORFAITS[3]; // Forfait unique par défaut si non précisé

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    await assurerCouponRemise();

    const centimesTTC = Math.round(forfait.centimesHT * (1 + TAUX_TVA));
    const remiseCentimesHT = Math.round(REMISE_MONTANT_CENTIMES_TTC / (1 + TAUX_TVA));
    const prixReduitHT = ((forfait.centimesHT - remiseCentimesHT) / 100).toFixed(2);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      locale: 'fr',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: centimesTTC,
            recurring: { interval: 'month' },
            product_data: {
              name: forfait.nom + (entreprise ? ' — ' + entreprise : ''),
              // "Sans engagement" placé en tête : Stripe tronque la description
              // dans la vue repliée du récapitulatif de paiement (visible
              // seulement en cliquant sur la flèche pour dérouler) — la mettre
              // en premier garantit qu'elle apparaît sans avoir à déplier.
              description: `Sans engagement — vous arrêtez quand vous voulez. Prix HT : ${(forfait.centimesHT / 100).toFixed(2)} € — TVA 20% incluse. Prix spécial artisan : ${prixReduitHT} € HT/mois pendant les 12 premiers mois, puis ${(forfait.centimesHT / 100).toFixed(2)} € HT/mois. Votre formulaire vitrine en ligne, mis à jour et actif chaque mois.`,
              images: ['https://www.skyeco.fr/skyeco-google-ads-carre.png'],
            },
          },
          quantity: 1,
        },
      ],
      discounts: [{ coupon: COUPON_REMISE_ID }],
      metadata: { draft_id: draftId, plan: String(plan || 1) },
      subscription_data: {
        metadata: { draft_id: draftId, plan: String(plan || 1) },
      },
      success_url: `${origin}/apercu.html?id=${draftId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/choisir-forfait.html?id=${draftId}&paiement=annule`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session Stripe :', err);
    return res.status(500).json({ error: err.message });
  }
}
