// /api/demander-pause.js
// L'artisan demande à mettre son abonnement en pause. Ça n'applique RIEN
// tout de suite — ça enregistre juste l'intention. Le vrai déclenchement se
// fait via SMS, 2 jours avant la fin de la période déjà payée (voir
// verifier-pauses-a-programmer.js et confirmer-pause.js).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const token = crypto.randomBytes(24).toString('hex');

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        pause_demandee: true,
        pause_confirmation_token: token,
        sms_pause_envoye: false,
      }),
    });

    return res.status(200).json({
      success: true,
      message: "Demande enregistrée. Vous recevrez un SMS 2 jours avant la fin de votre période en cours, avec un lien pour confirmer la mise en pause.",
    });
  } catch (err) {
    console.error('Erreur demander-pause :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
