// /api/verifier-siret.js
//
// Interroge l'API publique et gratuite "Recherche d'Entreprises"
// (recherche-entreprises.api.gouv.fr, DINUM/INSEE, sans clé requise) pour
// retrouver la forme juridique officielle d'un SIRET.
//
// IMPORTANT — ce que cet endpoint peut et ne peut PAS dire :
//   - Il peut confirmer la FORME JURIDIQUE (ex : "Entrepreneur individuel"),
//     donnée publique et fiable.
//   - Il NE PEUT PAS confirmer le régime de TVA réel (franchise en base ou
//     non), qui dépend du chiffre d'affaires réellement réalisé par
//     l'artisan — une donnée que personne d'autre que lui ne connaît.
// Le champ "suggestionFranchiseTva" renvoyé ici n'est donc qu'une case
// PRÉ-COCHÉE à titre d'aide (la plupart des entrepreneurs individuels sont
// en franchise), jamais une valeur appliquée sans que l'artisan la
// confirme lui-même dans mes-elements.html.
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

    return res.status(200).json({
      success: true,
      trouve: true,
      denomination: resultat.nom_raison_sociale || resultat.nom_complet || null,
      natureJuridique,
      libelleNature,
      suggestionFranchiseTva,
    });
  } catch (err) {
    console.error('Erreur verifier-siret :', err);
    return res.status(500).json({ success: false, error: "Impossible de vérifier ce SIRET pour le moment — vous pouvez cocher la case manuellement." });
  }
}
