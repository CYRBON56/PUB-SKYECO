// /api/get-google-ads-details.js
// Détail avancé de la campagne Google Ads d'un artisan (via Windsor.ai) :
//   - la performance de chaque mot-clé (clics, coût) — pour juger si un mot-clé
//     est pertinent ou s'il vaut mieux l'exclure ;
//   - la répartition des clics heure par heure sur la journée — pour repérer
//     les créneaux les plus rentables.
// Ne modifie rien : lecture seule. Les actions (ajouter/exclure/retirer un
// mot-clé) sont dans /api/manage-keywords.js.
//
// Variables d'environnement requises :
//   WINDSOR_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const TAUX_COMMISSION = 0.50; // doit rester synchronisé avec les autres fichiers

async function interrogerWindsor(campaignId, fields, dateDepart) {
  const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', campaignId]]));
  let url = `https://connectors.windsor.ai/google_ads?api_key=${process.env.WINDSOR_API_KEY}&fields=${fields}&filter=${filtre}`;
  url += dateDepart ? `&date_from=${dateDepart}` : `&date_preset=last_30d`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Windsor.ai a répondu une erreur : ${JSON.stringify(data)}`);
  return data.data || [];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draft_id } = req.body || {};
  if (!draft_id) {
    return res.status(400).json({ success: false, error: 'draft_id manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=google_ads_campaign_resource,derniere_recharge_le`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const draft = draftRows[0];

    if (!draft?.google_ads_campaign_resource) {
      return res.status(200).json({ success: true, campagneExiste: false });
    }

    const dateDepart = draft.derniere_recharge_le
      ? new Date(draft.derniere_recharge_le).toISOString().slice(0, 10)
      : undefined;

    const [lignesMotsCles, lignesHeures] = await Promise.all([
      interrogerWindsor(
        draft.google_ads_campaign_resource,
        'keyword_criterion_id,keyword_text,keyword_match_type,keyword_status,clicks,cost',
        dateDepart
      ),
      interrogerWindsor(draft.google_ads_campaign_resource, 'hour_of_day,clicks', dateDepart),
    ]);

    // Regroupe par mot-clé (Windsor peut renvoyer plusieurs lignes par mot-clé
    // — par jour, par réseau, etc. — jamais un total déjà agrégé).
    const motsClesParId = new Map();
    for (const ligne of lignesMotsCles) {
      const id = ligne.keyword_criterion_id || ligne.keyword_text;
      if (!id) continue;
      if (!motsClesParId.has(id)) {
        motsClesParId.set(id, {
          criterionId: ligne.keyword_criterion_id || null,
          texte: ligne.keyword_text || '(inconnu)',
          matchType: ligne.keyword_match_type || 'BROAD',
          statut: ligne.keyword_status || 'ENABLED',
          clics: 0,
          coutEuros: 0,
        });
      }
      const entree = motsClesParId.get(id);
      entree.clics += Number(ligne.clicks) || 0;
      entree.coutEuros += Number(ligne.cost) || 0;
    }
    const motsCles = [...motsClesParId.values()]
      .map(m => ({ ...m, coutEuros: +m.coutEuros.toFixed(2), cpcMoyenEuros: m.clics > 0 ? +(m.coutEuros / m.clics).toFixed(2) : null }))
      .sort((a, b) => b.clics - a.clics);

    // Regroupe les clics par heure de la journée (0-23).
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

    return res.status(200).json({
      success: true,
      campagneExiste: true,
      motsCles,
      clicsParHeure,
      heuresDePointe,
    });
  } catch (err) {
    console.error('Erreur get-google-ads-details (Windsor.ai) :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
