// /api/get-campaign-spend.js
// Interroge la vraie dépense/clics Google Ads via l'API Windsor.ai, et calcule
// la consommation ajustée du solde artisan (chaque € Google = 2€ du solde,
// puisque la commission de service est de 50%).
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const TAUX_COMMISSION = 0.50; // doit rester synchronisé avec les autres fichiers
const FACTEUR_CONSOMMATION = 1 / (1 - TAUX_COMMISSION);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draft_id } = req.body || {};
  if (!draft_id) {
    return res.status(400).json({ error: 'draft_id manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=entreprise,google_ads_campaign_resource,tarif_prix,derniere_recharge_le`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];

    if (!draft?.google_ads_campaign_resource) {
      return res.status(200).json({ success: true, campagneExiste: false });
    }

    // Lecture des vraies données Google Ads (clics + coût) sur la campagne,
    // filtrée depuis la dernière recharge de budget.
    const dateDepart = draft.derniere_recharge_le
      ? new Date(draft.derniere_recharge_le).toISOString().slice(0, 10)
      : undefined;

    const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', draft.google_ads_campaign_resource]]));
    let url = `https://connectors.windsor.ai/google_ads?api_key=${process.env.WINDSOR_API_KEY}&fields=clicks,cost&filter=${filtre}`;
    url += dateDepart ? `&date_from=${dateDepart}` : `&date_preset=last_30d`;

    const windsorResp = await fetch(url);
    const windsorData = await windsorResp.json();
    if (!windsorResp.ok) throw new Error(`Windsor.ai a répondu une erreur : ${JSON.stringify(windsorData)}`);

    const lignes = windsorData.data || [];
    const clics = lignes.reduce((acc, l) => acc + (Number(l.clicks) || 0), 0);
    const coutReelEuros = lignes.reduce((acc, l) => acc + (Number(l.cost) || 0), 0);

    const consommationAjustee = +(coutReelEuros * FACTEUR_CONSOMMATION).toFixed(2);
    const budgetPaye = draft.tarif_prix || 0;
    const budgetRestant = +Math.max(0, budgetPaye - consommationAjustee).toFixed(2);
    const pourcentageConsomme = budgetPaye > 0 ? Math.min(100, Math.round((consommationAjustee / budgetPaye) * 100)) : 0;

    return res.status(200).json({
      success: true,
      campagneExiste: true,
      clics,
      coutReelGoogleEuros: +coutReelEuros.toFixed(2),
      consommationAjustee,
      budgetPaye,
      budgetRestant,
      pourcentageConsomme,
    });
  } catch (err) {
    console.error('Erreur get-campaign-spend (Windsor.ai) :', err);
    return res.status(500).json({ error: err.message });
  }
}
