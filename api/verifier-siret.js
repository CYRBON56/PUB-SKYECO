// /api/verifier-siret.js
//
// Interroge l'API publique et gratuite "Recherche d'Entreprises"
// (recherche-entreprises.api.gouv.fr, DINUM/INSEE, sans clé requise) pour
// retrouver la forme juridique officielle d'un SIRET.
//
// 25/09/2026 : étendu pour retourner aussi la dénomination et l'adresse de
// l'établissement (rue/CP/ville) — jusqu'ici seule la forme juridique était
// renvoyée. Demandé par Cyrille : le bloc "Commencez par votre SIRET" en
// tête de construire-ma-vitrine.html doit pré-remplir en un seul geste le
// nom, l'adresse ET la forme juridique — une grosse partie de l'entête des
// futurs devis de l'artisan — plutôt que de ne confirmer que la forme
// juridique comme le faisait jusqu'ici le bouton "Vérifier ma forme
// juridique via mon SIRET" (toujours en place, toujours compatible avec
// cette réponse enrichie). Champs ajoutés : adresse, codePostal, ville.
//
// IMPORTANT — ce que cet endpoint peut et ne peut PAS dire :
//   - Il peut confirmer la FORME JURIDIQUE (ex : "Entrepreneur individuel"),
//     le nom et l'adresse de l'établissement, données publiques et fiables.
//   - Il NE PEUT PAS confirmer le régime de TVA réel (franchise en base ou
//     non), qui dépend du chiffre d'affaires réellement réalisé par
//     l'artisan — une donnée que personne d'autre que lui ne connaît.
// Le champ "suggestionFranchiseTva" renvoyé ici n'est donc qu'une case
// PRÉ-COCHÉE à titre d'aide (la plupart des entrepreneurs individuels sont
// en franchise), jamais une valeur appliquée sans que l'artisan la
// confirme lui-même dans construire-ma-vitrine.html.
//
// Requête : POST { siret }
// Aucune authentification nécessaire (données publiques, pas de données
// artisan/client en jeu).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  const { siret } = req.body || {};
  const siretPropre = String(siret || '').replace(/\s/g, '');
  if (!/^\d{14}$/.test(siretPropre)) {
    return res.status(400).json({ success: false, error: 'SIRET invalide (14 chiffres attendus).' });
  }

  try {
    const resp = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${siretPropre}`);
    if (!resp.ok) throw new Error(`API gouv a répondu ${resp.status}`);
    const data = await resp.json();
    const resultat = (data.results || [])[0];
    if (!resultat) {
      return res.status(200).json({ success: true, trouve: false });
    }

    const natureJuridique = resultat.nature_juridique || null; // ex "1000"
    const libelleNature = resultat.libelle_nature_juridique || null; // ex "Entrepreneur individuel"
    // Codes INSEE 1000-1999 = entreprises individuelles (catégorie la plus
    // fréquente chez les auto-entrepreneurs/micro-entrepreneurs) — simple
    // indice, pas une certitude (voir avertissement en tête de fichier).
    const suggestionFranchiseTva = !!(natureJuridique && natureJuridique.startsWith('1'));

    // 25/09/2026 : l'établissement correspondant exactement au SIRET demandé
    // (et non le siège par défaut, si l'artisan a donné l'établissement d'un
    // autre site) — même logique que public/skyeco-pro-inscription-siret.html.
    const matching = (resultat.matching_etablissements || []).find(e => e.siret === siretPropre);
    const etablissement = matching || resultat.siege || {};

    return res.status(200).json({
      success: true,
      trouve: true,
      denomination: resultat.nom_raison_sociale || resultat.nom_complet || null,
      natureJuridique,
      libelleNature,
      suggestionFranchiseTva,
      adresse: etablissement.adresse || null,
      codePostal: etablissement.code_postal || null,
      ville: etablissement.libelle_commune || null,
    });
  } catch (err) {
    console.error('Erreur verifier-siret :', err);
    return res.status(500).json({ success: false, error: "Impossible de vérifier ce SIRET pour le moment — vous pouvez cocher la case manuellement." });
  }
}
