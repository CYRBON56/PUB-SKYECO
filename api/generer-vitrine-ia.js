// /api/generer-vitrine-ia.js
// Assistant IA "construire ma vitrine" (mes-elements.html, nouveau bloc
// au-dessus de la section "Titre de votre vitrine") — demandé par Cyrille le
// 10/09/2026 : au lieu de choisir parmi des titres génériques par métier
// (api/suggerer-titre.js, conservé tel quel), l'artisan décrit son activité
// avec ses propres mots en quelques phrases libres, et l'IA en tire :
//   - plusieurs titres d'accroche vraiment sur-mesure (bien plus spécifiques
//     que les titres pré-écrits, puisqu'ils s'appuient sur ce que l'artisan
//     a réellement décrit : son savoir-faire, sa zone, ce qui le distingue) ;
//   - une suggestion de métier principal (simple indication affichée à
//     l'artisan, PAS enregistrée automatiquement ici — le métier réel qui
//     pilote le ciblage Google Ads et les gabarits de vitrine se choisit
//     dans le tableau de bord, mon-dashboard.html, pour ne pas créer un
//     deuxième endroit qui écrit cette valeur).
//
// Portée volontairement limitée à ce que mes-elements.html peut réellement
// personnaliser par artisan : le titre. Le reste du contenu de la vitrine
// (accroche, présentation, liste de prestations) provient des gabarits
// METIER_TEMPLATES communs (public/apercu.html), entretenus par Cyrille —
// voir la décision du 04/09/2026 de garder le formulaire personnalisé/le
// chiffrage en construction manuelle plutôt qu'en libre-service IA ; ce
// nouvel assistant ne touche pas à ce périmètre-là.
//
// Variable d'environnement requise : ANTHROPIC_API_KEY (même clé que
// api/suggerer-titre.js, api/interpreter-chiffrage.js, etc.)

const METIER_LABELS = {
  paysagiste: 'Paysagiste',
  piscine: 'Pose piscine',
  tonte: 'Tonte et coupe',
  terrasse: 'Terrasse',
  paysagiste_concepteur: 'Paysagiste concepteur',
  arboriste: 'Arboriste élagueur',
  espaces_verts: "Entretien d'espaces verts",
  resine: 'Revêtement en résine',
  autre: 'Autre',
};

function construirePrompt(description, metiers, zone) {
  const listeMetiers = Array.isArray(metiers) && metiers.length
    ? metiers.map(m => METIER_LABELS[m] || m).join(', ')
    : null;
  const zoneTexte = zone ? `\nZone d'intervention : ${zone}.` : '';
  const metierTexte = listeMetiers ? `\nMétier déjà renseigné par ailleurs : ${listeMetiers}.` : '';
  const clesMetiers = Object.keys(METIER_LABELS).join(', ');

  return `Tu aides un artisan français du BTP/paysagisme à construire le meilleur titre d'accroche pour la vitrine web qu'il montre à ses futurs clients particuliers.

Voici, avec ses propres mots, comment l'artisan décrit son activité :
"""
${description}
"""
${metierTexte}${zoneTexte}

À partir de cette description :
1. Propose 4 titres d'accroche courts et percutants (entre 4 et 9 mots chacun), sur-mesure pour CET artisan précis — appuie-toi sur ce qu'il a vraiment décrit (son savoir-faire, ce qui le distingue, sa zone si donnée), jamais des formules génériques creuses ("Votre satisfaction, notre priorité"). Donne confiance, donne envie de demander un devis.
2. Devine le métier principal qui correspond le mieux à cette description, en choisissant EXACTEMENT une des clés suivantes : ${clesMetiers}. Si aucune ne correspond clairement, réponds "autre".

Réponds STRICTEMENT en JSON valide, sans aucun texte avant ou après, sous cette forme exacte :
{ "titres": ["titre 1", "titre 2", "titre 3", "titre 4"], "metierSuggere": "cle_metier" }`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { description, metiers, zone } = req.body || {};
  if (typeof description !== 'string' || description.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'Merci de décrire votre activité en au moins quelques mots.' });
  }
  if (description.length > 2000) {
    return res.status(400).json({ success: false, error: 'Description trop longue (2000 caractères maximum).' });
  }

  try {
    const prompt = construirePrompt(description.trim(), metiers, zone);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail);
    }

    const data = await resp.json();
    const texteBrut = (data.content || [])
      .map(bloc => (bloc.type === 'text' ? bloc.text : ''))
      .join('')
      .trim();

    let resultat;
    try {
      const nettoye = texteBrut.replace(/```json|```/g, '').trim();
      resultat = JSON.parse(nettoye);
    } catch (erreurParse) {
      throw new Error('Réponse IA illisible : ' + texteBrut.slice(0, 300));
    }

    const titres = Array.isArray(resultat.titres)
      ? resultat.titres.filter(t => typeof t === 'string' && t.trim()).slice(0, 4)
      : [];
    if (!titres.length) {
      throw new Error('Aucun titre généré.');
    }

    const metierSuggere = Object.prototype.hasOwnProperty.call(METIER_LABELS, resultat.metierSuggere)
      ? resultat.metierSuggere
      : null;

    return res.status(200).json({
      success: true,
      titres,
      metierSuggere,
      metierSuggereLabel: metierSuggere ? METIER_LABELS[metierSuggere] : null,
    });
  } catch (err) {
    console.error('Erreur generer-vitrine-ia :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
