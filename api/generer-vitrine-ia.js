// /api/generer-vitrine-ia.js
// Assistant IA "construire ma vitrine complète" (mes-elements.html, bloc
// au-dessus de la section "Titre de votre vitrine") — demandé par Cyrille le
// 10/09/2026. L'artisan décrit son activité avec ses propres mots en
// quelques phrases libres, et l'IA en tire :
//   1. plusieurs titres d'accroche sur-mesure (bien plus spécifiques que les
//      titres pré-écrits par métier, api/suggerer-titre.js, conservé tel
//      quel) ;
//   2. une suggestion de métier principal (affichée à titre indicatif — le
//      métier qui pilote réellement le ciblage Google Ads et les gabarits de
//      vitrine reste choisi dans mon-dashboard.html, jamais écrit ici) ;
//   3. (10/09, extension "vitrine complète") un BROUILLON du formulaire de
//      devis personnalisé — questions à poser au client + logique de calcul
//      du prix. Ce brouillon n'active RIEN automatiquement : conformément à
//      la décision du 04/09/2026 (garder le formulaire personnalisé construit
//      à la main pour garder le contrôle qualité sur les prix affichés), il
//      est déposé dans le champ "Décrivez le formulaire dont vous avez
//      besoin" existant et suit le circuit déjà en place
//      (checkFormulairePersonnalise + api/demander-formulaire-personnalise.js)
//      — Cyrille (ou Claude sur sa demande) le relit et le code à la main
//      dans public/apercu.html (PARCOURS_PERSONNALISES) avant qu'il soit
//      utilisé par un vrai visiteur. Rien n'est jamais mis en ligne
//      directement depuis cet endpoint.
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

  return `Tu aides un artisan français du BTP/paysagisme à préparer sa vitrine web, destinée à ses futurs clients particuliers.

Voici, avec ses propres mots, comment l'artisan décrit son activité :
"""
${description}
"""
${metierTexte}${zoneTexte}

Fais trois choses à partir de cette description :

1. Propose 4 titres d'accroche courts et percutants (entre 4 et 9 mots chacun), sur-mesure pour CET artisan précis — appuie-toi sur ce qu'il a vraiment décrit (son savoir-faire, ce qui le distingue, sa zone si donnée), jamais des formules génériques creuses ("Votre satisfaction, notre priorité"). Donne confiance, donne envie de demander un devis.

2. Devine le métier principal qui correspond le mieux à cette description, en choisissant EXACTEMENT une des clés suivantes : ${clesMetiers}. Si aucune ne correspond clairement, réponds "autre".

3. Rédige un BROUILLON du formulaire de devis à poser à ses futurs clients sur sa vitrine — c'est une proposition qu'un humain (Cyrille, le fondateur du service, ou une personne qu'il mandate) relira et codera lui-même avant toute mise en ligne, donc écris-le comme un cahier des charges clair et actionnable, pas comme du code :
   - une liste ordonnée de questions à poser au client, chacune avec : la question exacte, son type (choix multiple avec ses options / nombre avec son unité / texte libre), et pourquoi elle sert au calcul du prix ;
   - une explication en langage clair de la façon de calculer un prix ou une fourchette de prix à partir des réponses (prix au m², au forfait, par option cumulée, etc.) — reste réaliste et raisonnable si l'artisan n'a donné aucun tarif, en le signalant clairement ("prix à définir par l'artisan pour X") plutôt qu'en inventant des chiffres.
   Si la description ne donne pas assez d'éléments pour un métier donné, base-toi sur les pratiques courantes de ce métier en France, et signale explicitement les hypothèses faites.

Réponds STRICTEMENT en JSON valide, sans aucun texte avant ou après, sous cette forme exacte :
{
  "titres": ["titre 1", "titre 2", "titre 3", "titre 4"],
  "metierSuggere": "cle_metier",
  "formulaireBrouillon": "texte du brouillon, avec retours à la ligne \\n pour la mise en page"
}`;
}

// Corrige un bug réel rencontré en production le 11/09 : malgré la
// consigne du prompt ("retours à la ligne \\n"), Claude renvoie parfois le
// texte de "formulaireBrouillon" avec de VRAIS retours à la ligne à
// l'intérieur de la valeur JSON (naturel vu que c'est un long texte
// multi-lignes de type cahier des charges) — hors JSON strict n'autorise
// aucun caractère de contrôle brut (saut de ligne/tabulation) à l'intérieur
// d'une chaîne, donc JSON.parse() échouait systématiquement dès que le
// brouillon dépassait une ligne ("Réponse IA illisible" affiché à
// l'artisan). Cette fonction ré-échappe ces caractères UNIQUEMENT à
// l'intérieur des chaînes JSON (en suivant l'état guillemets/échappement
// caractère par caractère), sans toucher au reste de la structure JSON.
function echapperControlesDansChaines(texteJson) {
  let resultat = '';
  let dansChaine = false;
  let echappementPrecedent = false;
  for (let i = 0; i < texteJson.length; i++) {
    const c = texteJson[i];
    if (!dansChaine) {
      if (c === '"') dansChaine = true;
      resultat += c;
      continue;
    }
    if (echappementPrecedent) {
      resultat += c;
      echappementPrecedent = false;
      continue;
    }
    if (c === '\\') {
      resultat += c;
      echappementPrecedent = true;
      continue;
    }
    if (c === '"') {
      dansChaine = false;
      resultat += c;
      continue;
    }
    if (c === '\n') { resultat += '\\n'; continue; }
    if (c === '\r') { continue; }
    if (c === '\t') { resultat += '\\t'; continue; }
    resultat += c;
  }
  return resultat;
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
        max_tokens: 1800,
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
      resultat = JSON.parse(echapperControlesDansChaines(nettoye));
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

    const formulaireBrouillon = typeof resultat.formulaireBrouillon === 'string' && resultat.formulaireBrouillon.trim()
      ? resultat.formulaireBrouillon.trim().slice(0, 4000)
      : null;

    return res.status(200).json({
      success: true,
      titres,
      metierSuggere,
      metierSuggereLabel: metierSuggere ? METIER_LABELS[metierSuggere] : null,
      formulaireBrouillon,
    });
  } catch (err) {
    console.error('Erreur generer-vitrine-ia :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
