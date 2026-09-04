// /api/get-google-ads-details.js
// Détail avancé de la campagne Google Ads d'un artisan (via Windsor.ai) :
//   - la performance de chaque mot-clé (clics, coût) — pour juger si un mot-clé
//     est pertinent ou s'il vaut mieux l'exclure ;
//   - la répartition des clics heure par heure sur la journée — pour repérer
//     les créneaux les plus rentables ;
//   - (04/09) les VRAIS termes de recherche qui ont déclenché une annonce —
//     distinct des mots-clés ci-dessus : un mot-clé en requête large/expression
//     peut déclencher des dizaines de recherches différentes, parfois hors
//     sujet. C'est ce rapport-là (search_term_view) que Google Ads met en
//     avant pour juger "où l'annonce se diffuse vraiment" ;
//   - (04/09) la répartition des clics par type d'appareil (mobile/ordinateur/
//     tablette).
// Ne modifie rien : lecture seule. Les actions (ajouter/exclure/retirer un
// mot-clé ou un terme de recherche) sont dans /api/manage-keywords.js. La
// répartition géographique des clics est un rapport à part, voir
// /api/clics-par-zone.js.
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

    const [lignesMotsCles, lignesHeures, lignesTermes, lignesAppareils] = await Promise.all([
      interrogerWindsor(
        draft.google_ads_campaign_resource,
        'keyword_criterion_id,keyword_text,keyword_match_type,keyword_status,clicks,cost',
        dateDepart
      ),
      interrogerWindsor(draft.google_ads_campaign_resource, 'hour_of_day,clicks', dateDepart),
      // search_term_view : les recherches réellement tapées par les
      // internautes (pas les mots-clés sur lesquels l'artisan enchérit — un
      // seul mot-clé en requête large ou expression peut correspondre à des
      // dizaines de recherches différentes).
      interrogerWindsor(
        draft.google_ads_campaign_resource,
        'search_term_view_search_term,search_term_view_status,clicks,cost',
        dateDepart
      ),
      interrogerWindsor(draft.google_ads_campaign_resource, 'device,clicks,cost', dateDepart),
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

    // Regroupe par terme de recherche réel (même logique que les mots-clés
    // ci-dessus — Windsor peut renvoyer plusieurs lignes par terme). Un
    // terme au statut "EXCLUDED" a déjà été bloqué comme mot-clé négatif
    // (par ce panneau ou directement dans Google Ads) — on le garde visible
    // mais sans bouton "Exclure".
    const termesParTexte = new Map();
    for (const ligne of lignesTermes) {
      const texte = ligne.search_term_view_search_term;
      if (!texte) continue;
      if (!termesParTexte.has(texte)) {
        termesParTexte.set(texte, {
          texte,
          statut: ligne.search_term_view_status || 'NONE',
          clics: 0,
          coutEuros: 0,
        });
      }
      const entree = termesParTexte.get(texte);
      entree.clics += Number(ligne.clicks) || 0;
      entree.coutEuros += Number(ligne.cost) || 0;
    }
    const termesRecherche = [...termesParTexte.values()]
      .map(t => ({ ...t, coutEuros: +t.coutEuros.toFixed(2), cpcMoyenEuros: t.clics > 0 ? +(t.coutEuros / t.clics).toFixed(2) : null }))
      .sort((a, b) => b.clics - a.clics)
      .slice(0, 30); // les 30 termes les plus cliqués suffisent à repérer les pertinents/à exclure

    // Regroupe par type d'appareil (MOBILE / DESKTOP / TABLET / CONNECTED_TV...).
    const appareilsParType = new Map();
    for (const ligne of lignesAppareils) {
      const type = ligne.device;
      if (!type) continue;
      if (!appareilsParType.has(type)) {
        appareilsParType.set(type, { type, clics: 0, coutEuros: 0 });
      }
      const entree = appareilsParType.get(type);
      entree.clics += Number(ligne.clicks) || 0;
      entree.coutEuros += Number(ligne.cost) || 0;
    }
    const totalClicsAppareils = [...appareilsParType.values()].reduce((s, a) => s + a.clics, 0);
    const appareils = [...appareilsParType.values()]
      .map(a => ({
        ...a,
        coutEuros: +a.coutEuros.toFixed(2),
        cpcMoyenEuros: a.clics > 0 ? +(a.coutEuros / a.clics).toFixed(2) : null,
        partPourcent: totalClicsAppareils > 0 ? Math.round((a.clics / totalClicsAppareils) * 100) : 0,
      }))
      .sort((a, b) => b.clics - a.clics);

    return res.status(200).json({
      success: true,
      campagneExiste: true,
      motsCles,
      termesRecherche,
      appareils,
      clicsParHeure,
      heuresDePointe,
    });
  } catch (err) {
    console.error('Erreur get-google-ads-details (Windsor.ai) :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
