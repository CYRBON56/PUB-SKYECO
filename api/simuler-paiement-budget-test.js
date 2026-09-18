// /api/simuler-paiement-budget-test.js
//
// Simule l'approvisionnement du budget publicitaire (campagne.html) SANS
// passer par Stripe — pour tester tout le tunnel essai gratuit → forfait →
// budget → campagne Google Ads réellement créée, sans dépenser un centime ni
// entrer de carte bancaire nulle part.
//
// Reproduit EXACTEMENT la même logique que api/confirm-ad-payment.js (même
// calcul TVA, mêmes champs mis à jour, même déclenchement de la campagne
// Google Ads) — seule différence : aucun appel à Stripe, le montant "payé"
// est directement celui fourni dans la requête.
//
// 17/09/2026 : Meta Ads (Facebook/Instagram) est retiré de Skyeco Pro — le
// déclenchement de create-meta-ads-campaign.js qui existait ici a été
// supprimé, ainsi que la colonne budget_repartition_meta_pourcent.
//
// Protégé par le même mot de passe interne que les autres outils de test
// (simuler-paiement-test.js pour le forfait, verify-test-bypass.js pour le
// SMS) — jamais accessible à un vrai artisan, quoi qu'il arrive côté
// client : campagne.html ne montre le bouton de simulation que si l'URL
// contient "&test=1".
//
// ⚠️ Comme pour simuler-paiement-test.js : le budget est bien marqué actif
// et une VRAIE campagne Google Ads est créée (en pause) via les endpoints
// habituels — utile pour tester le parcours de bout en bout, pas pour
// tester la facturation elle-même (pas de session Stripe, pas de facture
// générée, factureUrl/facturePdfUrl toujours null ici).
//
// Requête attendue : POST { draftId, budget, motDePasseInterne }
//   - budget : montant TTC (même sens que sur campagne.html — le montant
//     que l'artisan aurait saisi avant de cliquer "Payer").
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INTERNAL_ACCESS_PASSWORD

const TAUX_TVA = 0.20;
const DUREE_ESSAI_JOURS = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, budget, motDePasseInterne } = req.body || {};
  if (!draftId || !budget) {
    return res.status(400).json({ success: false, error: 'draftId et budget requis.' });
  }
  if (!process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(500).json({ success: false, error: 'Mot de passe interne non configuré côté serveur.' });
  }
  if (motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }

  const budgetTTC = parseFloat(budget);
  if (Number.isNaN(budgetTTC) || budgetTTC < 100) {
    return res.status(400).json({ success: false, error: 'Montant invalide (minimum 100 €).' });
  }
  const budgetHT = Math.round((budgetTTC / (1 + TAUX_TVA)) * 100) / 100;

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    let statutActuel = null;
    const statutResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=id,status`,
      { headers: supaHeaders }
    );
    const statutRows = await statutResp.json();
    if (!statutRows[0]) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }
    statutActuel = statutRows[0].status || null;

    const champsAMettreAJour = {
      tarif_actif: true,
      tarif_prix: budgetHT,
      derniere_recharge_le: new Date().toISOString(),
      alerte_solde_bas_envoyee: false,
    };
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
      console.error('Erreur mise à jour budget (simulation) :', JSON.stringify(errData));
      return res.status(500).json({ success: false, error: "Échec de l'enregistrement." });
    }

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
        console.error('[TEST] Campagne Google Ads non créée automatiquement :', JSON.stringify(campagneData));
      }
    } catch (campagneErr) {
      console.error('[TEST] Erreur appel création campagne Google Ads :', campagneErr);
    }

    return res.status(200).json({
      success: true,
      test: true,
      budgetPayeTTC: budgetTTC,
      budgetActif: budgetHT,
      campagneCreee: !!campagne?.success,
      campagneMessage: campagne?.success
        ? "Votre campagne a été créée en pause — elle sera vérifiée avant diffusion."
        : "Budget enregistré, mais la campagne n'a pas pu être créée automatiquement.",
      factureUrl: null,
      facturePdfUrl: null,
    });
  } catch (err) {
    console.error('Erreur simuler-paiement-budget-test :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
