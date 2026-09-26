// /api/create-checkout-session.js
// Crée une session Stripe pour ABONNER un artisan à Skyeco Pro (récurrent
// mensuel), et non plus un paiement unique de mise en ligne.
// Variables d'environnement requises (à définir dans Vercel, jamais dans le code) :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (pour vérifier l'éligibilité à
//   la remise de fidélité Estimateur BTP, voir plus bas)

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
// à un tarif plus élevé après 12 mois — 39,90€ HT/mois à vie.
//
// 18/09/2026 : même changement appliqué aux forfaits "vitrine
// supplémentaire" — Cyrille a retiré la remise de lancement (-50%,
// 99,90€→59,90€) partout. Deux tarifs fixes désormais, sans coupon ni
// palier temporaire :
//   - forfait 5 : 3e ET 4e vitrine du compte → 59,90€ HT/mois, à vie.
//   - forfait 6 (nouveau) : 5e ET 6e vitrine du compte (et au-delà, faute
//     d'indication contraire de Cyrille) → 79,90€ HT/mois, à vie.
// Le coupon COUPON_REMISE_ID / PLANS_AVEC_REMISE ci-dessous ne s'applique
// donc plus à aucun forfait ; le mécanisme est laissé en place (inutilisé)
// au cas où une future remise de lancement serait réintroduite.
const TAUX_TVA = 0.20;
const FORFAITS = {
  3: { nom: 'Skyeco Pro — Vitrine + Dashboard + Relances & devis signés', centimesHT: 3990 },
  // Rang de la vitrine (1ère/2e vs 3e/4e vs 5e/6e+) déterminé côté page
  // (choisir-forfait.html, comptage des vitrines du compte par email) et
  // transmis ici via "plan" — jamais recalculé côté serveur ici, mais la
  // commission de 30% sur le budget pub (TAUX_COMMISSION,
  // api/estimate-reach.js et api/create-google-ads-campaign.js) ne dépend
  // pas du forfait choisi et reste donc inchangée quel que soit le plan.
  5: { nom: 'Skyeco Pro — Vitrine supplémentaire (3e et 4e vitrine)', centimesHT: 5990 },
  6: { nom: 'Skyeco Pro — Vitrine supplémentaire (5e et 6e vitrine et suivantes)', centimesHT: 7990 },
};

// Remise de lancement — plus utilisée par aucun forfait depuis le 18/09/2026
// (voir note ci-dessus), mécanisme conservé inactif pour une éventuelle
// remise future. Le montant du coupon est exprimé en TTC (4800 centimes,
// soit 48€ TTC = 40€ HT) car nos prix n'utilisent pas le calcul de taxe
// Stripe — la TVA est déjà intégrée dans unit_amount ci-dessous.
const COUPON_REMISE_ID = 'skyeco-remise-1ere-annee';
const REMISE_DUREE_MOIS = 12;
const REMISE_MONTANT_CENTIMES_TTC = 4800;
// Aucun forfait ne garde de remise temporaire (voir note du 18/09 ci-dessus).
const PLANS_AVEC_REMISE = [];

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

// 26/09/2026 : remise de fidélité pour les artisans qui ont DÉJÀ PAYÉ pour
// l'Estimateur BTP (achat direct ou via le Kit Pro Artisan BTP, qui l'inclut)
// et qui souscrivent à Skyeco Pro — sur demande de Cyrille. -5€ HT/mois
// pendant 12 mois sur le forfait standard (3) uniquement : 39,90€ HT ->
// 34,90€ HT/mois pendant 1 an, puis retour à 39,90€ HT/mois. Coupon distinct
// du COUPON_REMISE_ID ci-dessus (montant différent, immuable une fois créé
// côté Stripe, et logique d'éligibilité différente — par email plutôt que
// par forfait).
const COUPON_FIDELITE_ESTIMATEUR_ID = 'skyeco-fidelite-estimateur-btp';
const REMISE_FIDELITE_DUREE_MOIS = 12;
const REMISE_FIDELITE_MONTANT_CENTIMES_TTC = 600; // 5€ HT * 1,20 TVA = 6€ TTC
const PLAN_AVEC_REMISE_FIDELITE = 3; // uniquement le forfait standard (39,90€ HT)
// Sources d'estimateur_btp_acces considérées comme "a déjà payé" : achat
// direct ('stripe') ou accès offert via le Kit Pro Artisan BTP ('kit_pro'),
// lui-même payant. 'essai' (essai gratuit en cours) n'y donne pas droit.
const SOURCES_ESTIMATEUR_PAYEES = ['stripe', 'kit_pro'];

async function assurerCouponFideliteEstimateur() {
  try {
    await stripe.coupons.retrieve(COUPON_FIDELITE_ESTIMATEUR_ID);
  } catch (e) {
    try {
      await stripe.coupons.create({
        id: COUPON_FIDELITE_ESTIMATEUR_ID,
        duration: 'repeating',
        duration_in_months: REMISE_FIDELITE_DUREE_MOIS,
        amount_off: REMISE_FIDELITE_MONTANT_CENTIMES_TTC,
        currency: 'eur',
        name: 'Remise fidélité Estimateur BTP (1ère année)',
      });
    } catch (e2) { /* déjà créé entre-temps, ou erreur transitoire : pas bloquant */ }
  }
}

// Vérifie, via Supabase, si l'artisan derrière ce brouillon a déjà payé pour
// l'Estimateur BTP. En cas de doute (erreur réseau, config manquante, email
// introuvable) on répond false : pas de remise plutôt qu'une remise
// accordée par erreur.
async function estEligibleRemiseFideliteEstimateur(draftId) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=email`,
      { headers }
    );
    if (!draftResp.ok) return false;
    const draftRows = await draftResp.json();
    const email = draftRows?.[0]?.email;
    if (!email) return false;

    const accesResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_acces?email=eq.${encodeURIComponent(String(email).toLowerCase())}&select=source&limit=1`,
      { headers }
    );
    if (!accesResp.ok) return false;
    const accesRows = await accesResp.json();
    const source = accesRows?.[0]?.source;
    return SOURCES_ESTIMATEUR_PAYEES.includes(source);
  } catch (e) {
    console.error('Erreur vérification éligibilité remise fidélité Estimateur BTP :', e.message);
    return false;
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

  // Remise de fidélité Estimateur BTP : seulement sur le forfait standard,
  // et seulement si l'artisan a déjà payé pour l'Estimateur BTP (voir
  // estEligibleRemiseFideliteEstimateur). Ne se cumule pas avec une
  // éventuelle remise de lancement (avecRemise, actuellement inutilisée).
  const avecRemiseFidelite = !avecRemise
    && Number(planId) === PLAN_AVEC_REMISE_FIDELITE
    && await estEligibleRemiseFideliteEstimateur(draftId);

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    if (avecRemise) await assurerCouponRemise();
    if (avecRemiseFidelite) await assurerCouponFideliteEstimateur();

    const centimesTTC = Math.round(forfait.centimesHT * (1 + TAUX_TVA));
    const remiseCentimesHT = Math.round(REMISE_MONTANT_CENTIMES_TTC / (1 + TAUX_TVA));
    const prixReduitHT = ((forfait.centimesHT - remiseCentimesHT) / 100).toFixed(2);
    const remiseFideliteCentimesHT = Math.round(REMISE_FIDELITE_MONTANT_CENTIMES_TTC / (1 + TAUX_TVA));
    const prixReduitFideliteHT = ((forfait.centimesHT - remiseFideliteCentimesHT) / 100).toFixed(2);
    const couponAAppliquer = avecRemise
      ? COUPON_REMISE_ID
      : (avecRemiseFidelite ? COUPON_FIDELITE_ESTIMATEUR_ID : null);

    const description = avecRemise
      ? `1er mois offert, puis sans engagement — vous arrêtez quand vous voulez. Prix HT : ${(forfait.centimesHT / 100).toFixed(2)} € — TVA 20% incluse. Prix spécial artisan : ${prixReduitHT} € HT/mois pendant les 12 premiers mois, puis ${(forfait.centimesHT / 100).toFixed(2)} € HT/mois. Votre formulaire vitrine en ligne, mis à jour et actif chaque mois.`
      : avecRemiseFidelite
      ? `1er mois offert, puis sans engagement — vous arrêtez quand vous voulez. Remise fidélité Estimateur BTP : ${prixReduitFideliteHT} € HT/mois pendant les 12 premiers mois (au lieu de ${(forfait.centimesHT / 100).toFixed(2)} € HT/mois), puis ${(forfait.centimesHT / 100).toFixed(2)} € HT/mois — TVA 20% incluse. Votre formulaire vitrine en ligne, mis à jour et actif chaque mois.`
      : `1er mois offert, puis sans engagement — vous arrêtez quand vous voulez. ${(forfait.centimesHT / 100).toFixed(2)} € HT/mois — TVA 20% incluse, sans remise temporaire ni changement de tarif dans le temps. Votre formulaire vitrine en ligne, mis à jour et actif chaque mois.`;

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
      ...(couponAAppliquer ? { discounts: [{ coupon: couponAAppliquer }] } : {}),
      metadata: { draft_id: draftId, plan: String(plan || 1), remise_fidelite_estimateur: String(avecRemiseFidelite) },
      subscription_data: {
        // 17/09/2026 (soir) : "le premier mois est gratuit" — jusqu'ici,
        // s'abonner via ce endpoint débitait la carte immédiatement, alors
        // même qu'un artisan qui vient de "Mettre en ligne" peut être en
        // plein milieu de son essai gratuit sans CB (statut 'essai', voir
        // mon-dashboard-demo.html) : il aurait payé tout de suite EN PLUS de
        // son mois gratuit en cours. Un essai Stripe de 30 jours sur
        // l'abonnement lui-même règle ça : la carte est enregistrée mais
        // jamais débitée avant J+30, qu'il ait ou non déjà démarré un essai
        // par ailleurs.
        trial_period_days: 30,
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
