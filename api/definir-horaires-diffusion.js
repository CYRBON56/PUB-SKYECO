// /api/definir-horaires-diffusion.js
// Pose ou retire une plage horaire de diffusion (dayparting) sur la
// campagne Google Ads d'un artisan, via l'action Windsor.ai
// "set_ad_schedule" (vérifiée disponible le 01/09 via list_actions).
//
// Deux modes :
//   'heures_pointe' — recalcule les heures de pointe réelles de la campagne
//                      (même logique que api/get-google-ads-details.js) et
//                      limite la diffusion à ces heures-là (+/- 1h de marge
//                      autour de chaque heure de pointe), tous les jours de
//                      la semaine.
//   'toute_heure'    — retire toute restriction (planning vide = diffusion
//                      24h/24, comportement par défaut de Google Ads).
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';
const JOURS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

async function executerAction(action, params) {
  const resp = await fetch(`${WINDSOR_BASE}/actions?api_key=${process.env.WINDSOR_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: process.env.GOOGLE_ADS_ACCOUNT_ID, action, params }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Action Windsor.ai "${action}" échouée : ${JSON.stringify(data)}`);
  return data;
}

async function interrogerWindsorLecture(campaignId, fields, dateDepart) {
  const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', campaignId]]));
  let url = `${WINDSOR_BASE}?api_key=${process.env.WINDSOR_API_KEY}&fields=${fields}&filter=${filtre}`;
  url += dateDepart ? `&date_from=${dateDepart}` : `&date_preset=last_30d`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Windsor.ai a répondu une erreur : ${JSON.stringify(data)}`);
  return data.data || [];
}

// Fusionne des heures de pointe isolées (ex: [10, 11, 19]) en fenêtres
// contiguës avec 1h de marge de chaque côté (ex: [9-13], [18-21]), pour
// éviter de créer une fenêtre par heure exacte — trop restrictif et peu
// lisible dans l'interface Google Ads.
function construireFenetres(heuresDePointe) {
  if (!heuresDePointe.length) return [];
  const elargies = new Set();
  heuresDePointe.forEach(h => {
    for (let d = -1; d <= 1; d++) {
      const hh = h + d;
      if (hh >= 0 && hh <= 23) elargies.add(hh);
    }
  });
  const heuresTriees = [...elargies].sort((a, b) => a - b);

  const fenetres = [];
  let debut = heuresTriees[0];
  let precedent = heuresTriees[0];
  for (let i = 1; i <= heuresTriees.length; i++) {
    const h = heuresTriees[i];
    if (h === precedent + 1) {
      precedent = h;
      continue;
    }
    fenetres.push({ start_hour: debut, end_hour: Math.min(24, precedent + 1) });
    if (h !== undefined) { debut = h; precedent = h; }
  }
  return fenetres;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, mode } = req.body || {};
  if (!draftId || !['heures_pointe', 'toute_heure'].includes(mode)) {
    return res.status(400).json({ success: false, error: 'draftId et mode ("heures_pointe" ou "toute_heure") requis.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=google_ads_campaign_resource,derniere_recharge_le`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    const campaignId = rows[0]?.google_ads_campaign_resource;
    if (!campaignId) {
      return res.status(404).json({ success: false, error: 'Aucune campagne active pour ce site.' });
    }

    if (mode === 'toute_heure') {
      await executerAction('set_ad_schedule', { campaign_id: campaignId, schedule: [] });
      return res.status(200).json({ success: true, schedule: [] });
    }

    // mode === 'heures_pointe' : recalcule les heures de pointe réelles à
    // partir des clics des 30 derniers jours (ou depuis la dernière
    // recharge si plus récente), même logique que
    // api/get-google-ads-details.js.
    const dateDepart = rows[0]?.derniere_recharge_le
      ? new Date(rows[0].derniere_recharge_le).toISOString().slice(0, 10)
      : undefined;
    const lignesHeures = await interrogerWindsorLecture(campaignId, 'hour_of_day,clicks', dateDepart);

    const clicsParHeure = Array(24).fill(0);
    for (const ligne of lignesHeures) {
      const heure = Number(ligne.hour_of_day);
      if (Number.isInteger(heure) && heure >= 0 && heure <= 23) {
        clicsParHeure[heure] += Number(ligne.clicks) || 0;
      }
    }
    const maxClicsHeure = Math.max(...clicsParHeure);
    const heuresDePointe = maxClicsHeure > 0
      ? clicsParHeure.reduce((acc, v, h) => (v === maxClicsHeure ? [...acc, h] : acc), [])
      : [];

    if (!heuresDePointe.length) {
      return res.status(400).json({ success: false, error: "Pas encore assez de clics pour dégager des heures de pointe fiables." });
    }

    const fenetres = construireFenetres(heuresDePointe);
    const schedule = JOURS.flatMap(jour =>
      fenetres.map(f => ({ day_of_week: jour, start_hour: f.start_hour, end_hour: f.end_hour }))
    );

    await executerAction('set_ad_schedule', { campaign_id: campaignId, schedule });

    return res.status(200).json({ success: true, heuresDePointe, fenetres, schedule });
  } catch (err) {
    console.error('Erreur definir-horaires-diffusion (Windsor.ai) :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
