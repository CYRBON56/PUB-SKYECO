// /api/suggerer-titre.js
// Suggère, via Claude, un titre pour le grand bandeau de la vitrine
// (mes-elements.html, section "Titre de votre vitrine"), à partir du/des
// métier(s) de l'artisan et éventuellement de sa zone d'intervention.
// Complète les titres pré-écrits déjà proposés (TITRES_PAR_METIER côté
// front) sans les remplacer — l'artisan choisit ensuite d'utiliser la
// suggestion ou l'un des titres existants.
//
// Variable d'environnement requise :
//   ANTHROPIC_API_KEY (même clé que api/interpreter-chiffrage.js)

const METIER_LABELS = {
  paysagiste: 'Paysagiste',
  piscine: 'Pose piscine',
  tonte: 'Tonte et coupe',
  terrasse: 'Terrasse',
  paysagiste_concepteur: 'Paysagiste concepteur',
  arboriste: 'Arboriste élagueur',
  espaces_verts: "Entretien d'espaces verts",
  autre: 'Autre',
};

function construirePrompt(metiers, zone) {
  const listeMetiers = metiers.map(m => METIER_LABELS[m] || m).join(', ');
  const zoneTexte = zone ? ` L'artisan travaille dans le secteur : ${zone}.` : '';

  return `Tu écris le grand titre d'accroche affiché en haut de la vitrine web d'un artisan français du BTP/paysagisme, destiné à ses futurs clients particuliers.

Métier(s) de l'artisan : ${listeMetiers}.${zoneTexte}

Propose 3 titres courts et percutants (entre 4 et 9 mots chacun), qui donnent confiance et donnent envie de faire une demande de devis. Évite les formules génériques creuses ("Votre satisfaction, notre priorité"), préfère des titres concrets, ancrés dans le métier, avec du caractère.

Réponds STRICTEMENT en JSON valide, sans aucun texte avant ou après, sous cette forme exacte :
{ "titres": ["titre 1", "titre 2", "titre 3"] }`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { metiers, zone } = req.body || {};
  if (!Array.isArray(metiers) || metiers.length === 0) {
    return res.status(400).json({ success: false, error: 'Aucun métier fourni.' });
  }

  try {
    const prompt = construirePrompt(metiers, zone);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
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

    const titres = Array.isArray(resultat.titres) ? resultat.titres.filter(t => typeof t === 'string' && t.trim()).slice(0, 3) : [];
    if (!titres.length) {
      throw new Error('Aucun titre généré.');
    }

    return res.status(200).json({ success: true, titres });
  } catch (err) {
    console.error('Erreur suggerer-titre :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
