// /api/create-checkout-kit-pro.js
// Crée une session Stripe pour ACHETER le "Kit Pro Artisan BTP" — paiement
// UNIQUE de 39 € TTC (32,50 € HT), pas d'abonnement.
//
// 24/11/2026 : ce fichier manquait depuis la mise en ligne du kit (la page
// kit-pro-artisan-btp.html l'appelait mais il n'existait pas, donc le bouton
// « Je commande mon kit » affichait une erreur). Prix passé de 29 € à 39 € TTC
// sur décision de Cyrille : le kit inclut l'Estimateur BTP (vendu seul
// 29,90 € HT) + le modèle de devis + les visuels réseaux sociaux en bonus.
//
// La livraison (email avec les fichiers + accès à l'Estimateur) est faite par
// api/stripe-webhook.js, qui ne traite que les sessions dont
// metadata.product = 'kit-pro-artisan-btp' et mode = 'payment'.
//
// Variable d'environnement requise : STRIPE_SECRET_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRIX_CENTIMES_TTC = 3900; // 39 € TTC, TVA 20 % incluse (32,50 € HT)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      locale: 'fr',
      // L'email est demandé par Stripe sur la page de paiement : c'est à
      // cette adresse que le webhook envoie les fichiers et ouvre l'accès à
      // l'Estimateur BTP.
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: PRIX_CENTIMES_TTC,
            product_data: {
              name: 'Kit Pro Artisan BTP',
              description: "Paiement unique, 39 € TTC (32,50 € HT), aucun abonnement. Estimateur BTP (accès à vie) + modèle de devis Word + 13 visuels réseaux sociaux.",
            },
          },
          quantity: 1,
        },
      ],
      invoice_creation: { enabled: true },
      metadata: { product: 'kit-pro-artisan-btp' },
      success_url: `${origin}/kit-pro-artisan-btp.html?paiement=ok`,
      cancel_url: `${origin}/kit-pro-artisan-btp.html?paiement=annule#prix`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-kit-pro error:', err.message);
    return res.status(500).json({ error: "Le paiement n'a pas pu démarrer." });
  }
}
