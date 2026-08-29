// /api/confirmer-pause.js
// Appelé quand l'artisan clique le lien reçu par SMS. C'est CE moment-là,
// et seulement celui-là, que la pause est réellement appliquée : plus de
// prélèvement à venir, et le site bascule sur la page de pause.
//
// Accessible en GET (lien cliquable directement depuis un SMS).
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function pageReponse(titre, message, couleur) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>body{font-family:-apple-system,sans-serif;background:#f5f8f6;color:#14312a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
  .card{background:#fff;border-radius:16px;padding:36px;max-width:420px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08);}
  h1{font-size:1.2rem;color:${couleur};margin-bottom:10px;}p{color:#5b6b64;line-height:1.6;font-size:0.92rem;}</style></head>
  <body><div class="card"><h1>${titre}</h1><p>${message}</p></div></body></html>`;
}

export default async function handler(req, res) {
  const { id: draftId, token } = req.query || {};

  if (!draftId || !token) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(pageReponse('Lien invalide', 'Ce lien est incomplet ou incorrect.', '#c0392b'));
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=stripe_subscription_id,pause_confirmation_token,pause_demandee`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    const draft = rows[0];

    if (!draft || draft.pause_confirmation_token !== token) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(403).send(pageReponse('Lien invalide', 'Ce lien a expiré ou ne correspond à aucune demande en cours.', '#c0392b'));
    }

    if (!draft.pause_demandee) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(pageReponse('Déjà traité', 'Cette pause a déjà été confirmée précédemment.', '#5b6b64'));
    }

    const dansUnMois = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await stripe.subscriptions.update(draft.stripe_subscription_id, {
      pause_collection: { behavior: 'void', resumes_at: dansUnMois },
    });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'en_pause',
        subscription_status: 'en_pause',
        pause_demandee: false,
      }),
    });

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(pageReponse(
      '✅ Pause confirmée',
      `Votre abonnement est maintenant en pause. Votre site affiche une page de pause à vos visiteurs. Reprise automatique le ${new Date(dansUnMois * 1000).toLocaleDateString('fr-FR')}, ou à tout moment avant ça depuis votre tableau de bord.`,
      '#1e6f4c'
    ));
  } catch (err) {
    console.error('Erreur confirmer-pause :', err);
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(pageReponse('Erreur', "La confirmation n'a pas pu être appliquée. Contactez-nous directement.", '#c0392b'));
  }
}
