// /api/_lib/destination-vitrine.js
// Détermine l'URL de destination d'une annonce Google Ads pour un artisan,
// selon le choix fait dans choisir-forfait.html (voir api/definir-mode-vitrine.js
// et le nouveau champ mode_vitrine sur skyeco_pro_vitrine_drafts, 14/09/2026) :
//   - 'ia' (par défaut, comportement historique) et 'sur_mesure' pointent
//     tous les deux vers la vitrine Skyeco (apercu.html) — dans les deux cas
//     c'est une vitrine Skyeco qui héberge le formulaire d'estimation, seule
//     la manière dont son contenu a été produit change (générée
//     automatiquement, ou construite à la main par Cyrille).
//   - 'site_externe' pointe vers le site personnel de l'artisan
//     (site_web_existant), SI cette URL est présente et a une forme valide.
//     En cas de doute (URL vide/invalide malgré le choix), on retombe sur
//     apercu.html plutôt que de bloquer la création de la campagne ou
//     d'envoyer du trafic payant vers une page qui n'existe pas.
//
// Utilisé par create-google-ads-campaign.js (création initiale) ET
// appliquer-annonce-ads.js (republication d'une annonce après modification
// des titres/mots-clés) — pour que les deux restent cohérents et qu'une
// simple mise à jour de texte ne fasse pas silencieusement revenir la
// destination vers apercu.html pour un artisan qui a choisi son propre site.

function normaliserUrlSite(urlBrute) {
  const brut = String(urlBrute || '').trim();
  if (!brut) return null;
  const avecSchema = /^https?:\/\//i.test(brut) ? brut : `https://${brut}`;
  try {
    const url = new URL(avecSchema);
    if (!url.hostname || !url.hostname.includes('.')) return null;
    return url.toString();
  } catch (e) {
    return null;
  }
}

function urlVitrineSkyeco(draftId) {
  return `https://app.skyeco.fr/apercu.html?id=${draftId}`;
}

// draftId est passé séparément (et pas lu sur `draft.id`) car les requêtes
// Supabase appelantes ne sélectionnent pas toujours la colonne `id` —
// seulement mode_vitrine/site_web_existant — pour rester légères ; le
// draftId est de toute façon déjà connu de l'appelant (paramètre de req).
function resoudreUrlDestination(draft, draftId) {
  const defaut = urlVitrineSkyeco(draftId);
  if (draft.mode_vitrine === 'site_externe') {
    const urlPerso = normaliserUrlSite(draft.site_web_existant);
    if (urlPerso) return urlPerso;
    // Choix "site existant" sans URL exploitable : on ne bloque pas la
    // création/mise à jour de l'annonce, on retombe sur la vitrine Skyeco.
  }
  return defaut;
}

export { resoudreUrlDestination, normaliserUrlSite, urlVitrineSkyeco };
