// /api/clics-par-zone.js
// Répartition géographique des clics Google Ads reçus (d'où viennent les
// clics), via la dimension "click_view_location_of_presence_*" de Windsor.ai
// — c'est la localisation physique réelle de la personne au moment du clic
// (et non la configuration de ciblage de la campagne).
//
// LIMITE CONNUE (importante) : Google Ads / Windsor.ai ne renvoient qu'un
// identifiant technique par zone (ex: "geoTargetConstants/9218241"), jamais
// le nom de la ville directement — il n'existe aujourd'hui aucun champ
// Windsor qui fasse cette traduction pour cette dimension précise (vérifié
// exhaustivement sur le connecteur google_ads). La table `geo_target_names`
// sert de cache pour les noms au fur et à mesure qu'ils sont résolus (par ex.
// renseignés manuellement depuis le rapport "Lieux" de l'interface Google Ads
// de l'artisan, qui affiche lui les noms en clair) ; tant qu'une zone n'y est
// pas encore renseignée, l'API renvoie son identifiant brut et le tableau de
// bord affiche "Secteur (réf. ...)" — les volumes de clics restent exacts et
// exploitables même sans nom, pour comparer les zones entre elles.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=google_ads_campaign_resource`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];

    if (!draft?.google_ads_campaign_resource) {
      return res.status(200).json({ success: true, campagneExiste: false, zones: [] });
    }

    const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', draft.google_ads_campaign_resource]]));
    const champs = 'click_view_location_of_presence_city,click_view_location_of_presence_region,clicks';
    const url = `https://connectors.windsor.ai/google_ads?api_key=${process.env.WINDSOR_API_KEY}&fields=${champs}&filter=${filtre}&date_preset=last_30d`;

    const windsorResp = await fetch(url);
    const windsorData = await windsorResp.json();
    if (!windsorResp.ok) throw new Error(`Windsor.ai a répondu une erreur : ${JSON.stringify(windsorData)}`);

    const lignes = windsorData.data || [];

    // Regroupe par ville (repli sur la région si la ville n'est pas connue
    // pour ce clic — arrive pour certains clics mobiles/imprécis).
    const totaux = new Map(); // id -> clics
    for (const l of lignes) {
      const id = l.click_view_location_of_presence_city || l.click_view_location_of_presence_region;
      if (!id) continue;
      totaux.set(id, (totaux.get(id) || 0) + (Number(l.clicks) || 0));
    }

    const ids = [...totaux.keys()];
    let noms = {};
    if (ids.length) {
      const filtreIds = ids.map(id => `"${id}"`).join(',');
      const cacheResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/geo_target_names?criteria_id=in.(${filtreIds})&select=criteria_id,nom`,
        { headers: supaHeaders }
      );
      if (cacheResp.ok) {
        const cacheRows = await cacheResp.json();
        noms = Object.fromEntries(cacheRows.filter(r => r.nom).map(r => [r.criteria_id, r.nom]));
      }
    }

    const zones = [...totaux.entries()]
      .map(([id, clics]) => ({
        id,
        nom: noms[id] || null,
        label: noms[id] || `Secteur (réf. ${id.replace('geoTargetConstants/', '')})`,
        clics,
      }))
      .sort((a, b) => b.clics - a.clics)
      .slice(0, 10);

    const resolutionDisponible = zones.some(z => z.nom);

    return res.status(200).json({ success: true, campagneExiste: true, zones, resolutionDisponible });
  } catch (err) {
    console.error('Erreur clics-par-zone (Windsor.ai) :', err);
    return res.status(500).json({ error: err.message });
  }
}
