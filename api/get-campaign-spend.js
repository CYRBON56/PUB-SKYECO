// /api/get-campaign-spend.js
// Interroge la vraie dépense/clics Google Ads via l'API Windsor.ai, et calcule
// la consommation ajustée du solde artisan (chaque € Google = 2€ du solde,
// puisque la commission de service est de 50%). Envoie un SMS d'alerte à
// l'artisan la première fois que son solde restant passe à 50€ ou moins.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

const TAUX_COMMISSION = 0.50; // doit rester synchronisé avec les autres fichiers
const FACTEUR_CONSOMMATION = 1 / (1 - TAUX_COMMISSION);
const SEUIL_ALERTE_SOLDE = 50; // €

async function envoyerSMS(to, body, fromOverride) {
  if (!to) return;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = fromOverride || process.env.TWILIO_FROM_NUMBER;
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
  } catch (e) {
    console.error('Erreur envoi SMS alerte solde :', e);
  }
}

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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=entreprise,telephone,twilio_phone_number,google_ads_campaign_resource,tarif_prix,derniere_recharge_le,alerte_solde_bas_envoyee,campagne_diffusion_pausee`,
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

    // Alerte solde bas — envoyée une seule fois par cycle de recharge, dès
    // que le seuil est franchi. Remise à zéro par confirm-ad-payment.js à
    // chaque nouvelle recharge.
    if (budgetRestant <= SEUIL_ALERTE_SOLDE && budgetPaye > 0 && !draft.alerte_solde_bas_envoyee) {
      const texteAlerte = `Bonjour, il vous reste environ ${budgetRestant} € de budget publicitaire Skyeco Ads. Pensez à recharger pour continuer à recevoir des demandes.`;
      await envoyerSMS(draft.telephone, texteAlerte, draft.twilio_phone_number);
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ alerte_solde_bas_envoyee: true }),
      });
    }

    return res.status(200).json({
      success: true,
      campagneExiste: true,
      clics,
      coutReelGoogleEuros: +coutReelEuros.toFixed(2),
      consommationAjustee,
      budgetPaye,
      budgetRestant,
      pourcentageConsomme,
      diffusionPausee: !!draft.campagne_diffusion_pausee,
    });
  } catch (err) {
    console.error('Erreur get-campaign-spend (Windsor.ai) :', err);
    return res.status(500).json({ error: err.message });
  }
}
