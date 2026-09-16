// api/_lib/marketplace-preferences.js
// Calcule les métiers/départements pour lesquels un artisan doit voir des
// contacts dans le catalogue "Leads Skyeco" (généralisation du 16/09/2026 —
// voir claude/skyeco-pro-brief-marketplace-leads.md : au départ le pilote
// était figé en dur sur "resine"/"56", Cyrille a demandé un système où
// chaque artisan reçoit des contacts selon SON PROPRE métier/zone, avec
// possibilité de personnaliser).
//
// Règle : si l'artisan a défini des préférences marketplace explicites
// (marketplace_metiers_souhaites / marketplace_departements_souhaites, non
// vides), elles priment ; sinon on retombe sur son métier/département
// déclarés sur sa propre vitrine (skyeco_pro_vitrine_drafts.metier /
// .departement) — comportement "ça marche tout seul" par défaut, sans
// qu'aucun artisan n'ait besoin de configurer quoi que ce soit.
//
// Attend un `draft` avec au moins : metier (array), departement (text),
// marketplace_metiers_souhaites (jsonb array ou null),
// marketplace_departements_souhaites (jsonb array ou null).
function preferencesEffectives(draft) {
  const metiersPersonnalises = Array.isArray(draft.marketplace_metiers_souhaites)
    ? draft.marketplace_metiers_souhaites.filter(m => typeof m === 'string' && m.trim())
    : [];
  const departementsPersonnalises = Array.isArray(draft.marketplace_departements_souhaites)
    ? draft.marketplace_departements_souhaites.filter(d => typeof d === 'string' && d.trim())
    : [];

  const metiersVitrine = Array.isArray(draft.metier) ? draft.metier.filter(m => typeof m === 'string' && m.trim()) : [];
  const departementsVitrine = draft.departement ? [String(draft.departement).trim()] : [];

  return {
    metiers: metiersPersonnalises.length ? metiersPersonnalises : metiersVitrine,
    departements: departementsPersonnalises.length ? departementsPersonnalises : departementsVitrine,
    utiliseValeursPersonnalisees: metiersPersonnalises.length > 0 || departementsPersonnalises.length > 0,
  };
}

export { preferencesEffectives };
