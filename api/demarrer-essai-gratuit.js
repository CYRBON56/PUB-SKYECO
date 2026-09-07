// /api/demarrer-essai-gratuit.js — VERSION COMPLÈTE DE REMPLACEMENT
//
// Changement du 07/09 : dans le nouveau parcours, l'essai gratuit démarre
// juste après l'inscription (depuis mon-dashboard-demo.html), AVANT même
// que la vitrine existe. On retire donc la vérification site_valide (il est
// impossible de valider un site qui n'a pas encore été rempli) — la
// vérification manuelle de Cyrille (vitrine + annonce + mots-clés) se fait
// désormais plus tard, au moment où l'artisan veut réellement lancer sa
// campagne Google Ads (nouveau contrôle à ajouter côté
// api/confirm-ad-payment.js).
//
// Ajout d'une protection idempotente : si l'essai a déjà été démarré pour
// ce brouillon (essai_gratuit_fin déjà posé), on ne réinitialise pas le
// compteur de 30 jours à chaque nouveau clic — on renvoie simplement la
// date de fin déjà existante.
//
// Colonnes Supabase requises sur skyeco_pro_vitrine_drafts (inchangées) :
//   essai_gratuit_debut   timestamptz
//   essai_gratuit_fin     timestamptz
//   essai_rappel_sms_envoye boolean default false
//   forfait_choisi        int
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
    // Idempotence : si l'essai a déjà été démarré, on ne le réinitialise pas.
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=essai_gratuit_fin`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Brouillon introuvable' });
    }
    if (draft.essai_gratuit_fin) {
      return res.status(200).json({ success: true, essaiFin: draft.essai_gratuit_fin, dejaDemarre: true });
    }

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
