// /api/demarrer-essai-gratuit.js
// Démarre un essai gratuit de 1 mois pour un artisan, sans paiement.
// Pose le statut 'essai' + une date de fin (essai_gratuit_fin, J+30) sur le
// brouillon. C'est api/verifier-essais-a-programmer.js (tâche planifiée
// quotidienne) qui surveille ensuite cette date : SMS de rappel à J-1, puis
// passage au statut 'essai_expire' si rien n'a été payé à l'échéance — ce
// statut bloque l'accès au tableau de bord (voir mon-dashboard.html) et
// renvoie automatiquement vers choisir-forfait.html pour régler.
//
// Colonnes Supabase requises sur skyeco_pro_vitrine_drafts (à créer si
// absentes) :
//   essai_gratuit_debut   timestamptz
//   essai_gratuit_fin     timestamptz
//   essai_rappel_sms_envoye boolean default false
//   forfait_choisi        int (déjà utilisé ailleurs si existant, sinon à créer)
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, plan } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const maintenant = new Date();
    const finEssai = new Date(maintenant.getTime() + 30 * 24 * 60 * 60 * 1000);

    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'essai',
          forfait_choisi: plan || 3,
          essai_gratuit_debut: maintenant.toISOString(),
          essai_gratuit_fin: finEssai.toISOString(),
          essai_rappel_sms_envoye: false,
        }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText);
    }

    const rows = await resp.json();
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Brouillon introuvable' });
    }

    return res.status(200).json({ success: true, essaiFin: finEssai.toISOString() });
  } catch (err) {
    console.error('Erreur demarrer-essai-gratuit :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
