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
//
// 17/09/2026 (soir) : sur demande de Cyrille, le forfait 3 (offre standard)
// passe à un tarif FIXE de 39,90€ HT/mois, sans remise temporaire ni retour
// à un tarif plus élevé après 12 mois — 39,90€ HT/mois à vie. Le coupon
// COUPON_REMISE_ID ci-dessous n'est donc plus appliqué au forfait 3, mais
// reste utilisé tel quel pour le forfait 5 (vitrine supplémentaire, 3e
// vitrine et suivantes d'un même compte), dont la structure remise
// 59,90€→99,90€ n'a pas été touchée par cette demande — à confirmer avec
// Cyrille si le même changement (tarif fixe, sans remise) doit s'y appliquer
// aussi.
const TAUX_TVA = 0.20;
const FORFAITS = {
  3: { nom: 'Skyeco Pro — Vitrine + Dashboard + Relances & devis signés', centimesHT: 3990 },
  // Tarif de la 3e vitrine (et suivantes) d'un même compte (03/09) : un
  // artisan qui gère déjà 2 vitrines paie 99,90€ HT/mois pour toute
  // vitrine supplémentaire, avec la remise de lancement (COUPON_REMISE_ID
  // ci-dessous) ramenant le prix à 59,90€ HT/mois pendant 12 mois. Le rang
  // de la vitrine (1ère/2e vs 3e+) est déterminé côté page
  // (choisir-forfait.html, comptage des vitrines du compte par email) et
  // transmis ici via "plan" — jamais recalculé côté serveur ici, mais la
  // commission de 30% sur le budget pub (TAUX_COMMISSION,
  // api/estimate-reach.js et api/create-google-ads-campaign.js) ne dépend
  // pas du forfait choisi et reste donc inchangée quel que soit le plan.
  5: { nom: 'Skyeco Pro — Vitrine supplémentaire (3e vitrine et suivantes)', centimesHT: 9990 },
};

// Remise de lancement 1ère année — ne s'applique plus qu'au forfait 5
// (vitrine supplémentaire) depuis le 17/09/2026 : 40€ HT/mois de remise
// pendant 12 mois, puis retour automatique à 99,90€ HT/mois à partir du 13e
// mois. Gérée nativement par un coupon Stripe "repeating" sur 12 mois :
// Stripe applique et retire la remise tout seul, aucune action de notre
// part au bout d'un an. Le montant du coupon est exprimé en TTC (4800
// centimes, soit 48€ TTC = 40€ HT) car nos prix n'utilisent pas le calcul
// de taxe Stripe — la TVA est déjà intégrée dans unit_amount ci-dessous.
const COUPON_REMISE_ID = 'skyeco-remise-1ere-annee';
const REMISE_DUREE_MOIS = 12;
const REMISE_MONTANT_CENTIMES_TTC = 4800;
// Seuls les forfaits listés ici gardent la remise temporaire ; le forfait 3
// est désormais à prix fixe (voir note ci-dessus).
const PLANS_AVEC_REMISE = [5];

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

  // 14/09/2026 (soir) : le blocage "site_valide" (retour 403 tant que Cyrille
  // n'avait pas validé la fiche à la main) est retiré — même changement que
  // choisir-forfait.html, pour la même raison : l'identité est désormais
  // vérifiée en amont par la page de connexion + la fiche SIRET/téléphone.

  const planId = plan || 3;
  const forfait = FORFAITS[plan] || FORFAITS[3]; // Forfait unique par défaut si non précisé
  const avecRemise = PLANS_AVEC_REMISE.includes(Number(planId));

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    if (avecRemise) await assurerCouponRemise();

    const centimesTTC = Math.round(forfait.centimesHT * (1 + TAUX_TVA));
    const remiseCentimesHT = Math.round(REMISE_MONTANT_CENTIMES_TTC / (1 + TAUX_TVA));
    const prixReduitHT = ((forfait.centimesHT - remiseCentimesHT) / 100).toFixed(2);

    const description = avecRemise
      ? `Sans engagement — vous arrêtez quand vous voulez. Prix HT : ${(forfait.centimesHT / 100).toFixed(2)} € — TVA 20% incluse. Prix spécial artisan : ${prixReduitHT} € HT/mois pendant les 12 premiers mois, puis ${(forfait.centimesHT / 100).toFixed(2)} € HT/mois. Votre formulaire vitrine en ligne, mis à jour et actif chaque mois.`
      : `Sans engagement — vous arrêtez quand vous voulez. ${(forfait.centimesHT / 100).toFixed(2)} € HT/mois — TVA 20% incluse, sans remise temporaire ni changement de tarif dans le temps. Votre formulaire vitrine en ligne, mis à jour et actif chaque mois.`;

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
              description,
              images: ['https://www.skyeco.fr/skyeco-google-ads-carre.png'],
            },
          },
          quantity: 1,
        },
      ],
      ...(avecRemise ? { discounts: [{ coupon: COUPON_REMISE_ID }] } : {}),
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
