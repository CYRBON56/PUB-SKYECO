// /api/simuler-paiement-test.js
// Simule la validation d'un forfait SANS passer par Stripe — pour te
// permettre de tester tout le parcours (les 4 forfaits, avec autant
// d'artisans de test que tu veux) sans payer réellement ni créer de vrais
// abonnements Stripe.
//
// Protégé par le même mot de passe interne que les autres pages d'admin —
// jamais accessible à un vrai artisan (choisir-forfait.html ne montre
// l'option de test que si l'URL contient "&test=1", et ce endpoint refuse
// toute requête sans le bon mot de passe, quoi qu'il arrive côté client).
//
// ⚠️ Le site passe bien en "published" comme après un vrai paiement, mais
// stripe_subscription_id est une valeur fictive ("TEST-...") : les
// fonctionnalités qui appellent réellement Stripe (pause d'abonnement,
// crédit publicitaire...) ne fonctionneront pas sur un site simulé de cette
// façon. Utile pour tester le parcours forfait → création du compte
// dashboard, pas la facturation.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   INTERNAL_ACCESS_PASSWORD

const PLANS_VALIDES = [1, 2, 3, 4];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, plan, motDePasseInterne } = req.body || {};
  if (!draftId || !plan) {
    return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
  }
  if (!process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(500).json({ success: false, error: 'Mot de passe interne non configuré côté serveur.' });
  }
  if (motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }
  const planNum = parseInt(plan, 10);
  if (!PLANS_VALIDES.includes(planNum)) {
    return res.status(400).json({ success: false, error: 'Forfait invalide.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=id`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }

    const faussIdAbonnement = `TEST-${draftId.slice(0, 8)}-${Date.now()}`;

    const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'published',
        stripe_subscription_id: faussIdAbonnement,
        subscription_status: 'active',
        forfait: planNum,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!patchResp.ok) throw new Error("Échec de l'enregistrement.");

    return res.status(200).json({ success: true, test: true });
  } catch (err) {
    console.error('Erreur simuler-paiement-test :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
