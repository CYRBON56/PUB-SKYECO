// /api/interpreter-chiffrage.js
// Interprète, via Claude, la description libre que l'artisan donne de ses prix
// (mes-elements.html, section "Chiffrage détaillé") et retourne, pour chacun
// de ses métiers, l'unité de facturation / le prix unitaire HT / le minimum
// facturé qu'on peut en déduire — pour pré-remplir le formulaire sans que
// l'artisan ait à remplir une grille ligne par ligne.
//
// Variable d'environnement requise :
//   ANTHROPIC_API_KEY (même clé que api/chat-skyeco.js)

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

const UNITES_VALIDES = ['m2', 'ml', 'm3', 'forfait'];

function construirePrompt(texte, metiers) {
  const listeMetiers = metiers.map(m => `- ${m} (${METIER_LABELS[m] || m})`).join('\n');

  return `Tu aides un artisan français du paysagisme/BTP à structurer sa grille tarifaire à partir d'une description libre de ses prix, pour pré-remplir un formulaire.

Métiers de cet artisan (utilise EXACTEMENT ces clés dans ta réponse, rien d'autre) :
${listeMetiers}

Unités de facturation possibles : "m2" (surface), "ml" (mètre linéaire), "m3" (volume), "forfait" (prix fixe, ni surface ni longueur ni volume).

Description donnée par l'artisan, dans ses propres mots, pas forcément structurée ni dans l'ordre des métiers ci-dessus :
"""
${texte}
"""

Pour CHAQUE métier listé ci-dessus, déduis de cette description :
- "unite" : celle qui correspond le mieux à la façon dont l'artisan facture ce métier précis (une des 4 valeurs ci-dessus)
- "prix" : le prix unitaire HT en euros, en nombre (ex: 3.5), sans symbole € ; null si non déductible du texte pour ce métier
- "minimum" : le minimum facturé en euros HT, en nombre ; null si non mentionné
- "note" : une phrase courte en français expliquant ce que tu as compris pour ce métier (pour que l'artisan puisse vérifier) ; null si le texte ne dit rien sur ce métier

Réponds STRICTEMENT en JSON valide, sans aucun texte avant ou après, selon ce schéma exact (une entrée par métier listé ci-dessus, ni plus ni moins) :
{
  "<cle_metier>": { "unite": "m2"|"ml"|"m3"|"forfait", "prix": number|null, "minimum": number|null, "note": string|null },
  ...
}

Règles :
- N'invente aucun prix qui n'est pas dans le texte ou clairement déductible d'une phrase du texte.
- Si le texte ne parle pas du tout d'un métier de la liste, mets prix, minimum et note à null pour ce métier, et "unite": "forfait" par défaut.
- Un même passage du texte peut concerner plusieurs métiers proches (ex: "espaces verts" peut couvrir tonte ET entretien) — dans ce cas applique la même info aux deux si c'est raisonnable, sans l'inventer pour un métier sans rapport.
- N'ajoute aucune clé qui ne soit pas dans la liste des métiers ci-dessus.`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { texte, metiers } = req.body || {};
  if (!texte || typeof texte !== 'string' || !texte.trim()) {
    return res.status(400).json({ success: false, error: 'Aucune description fournie.' });
  }
  if (!Array.isArray(metiers) || metiers.length === 0) {
    return res.status(400).json({ success: false, error: 'Aucun métier fourni.' });
  }

  // Ne garde que des clés métier connues, pour ne pas laisser un texte
  // arbitraire dicter la forme du JSON qu'on va parser ensuite.
  const metiersConnus = metiers.filter(m => Object.prototype.hasOwnProperty.call(METIER_LABELS, m));
  if (!metiersConnus.length) {
    return res.status(400).json({ success: false, error: 'Métiers non reconnus.' });
  }

  try {
    const prompt = construirePrompt(texte.trim().slice(0, 4000), metiersConnus);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
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

    let tarifs;
    try {
      const nettoye = texteBrut.replace(/```json|```/g, '').trim();
      tarifs = JSON.parse(nettoye);
    } catch (erreurParse) {
      console.error('Réponse Claude non parsable (interpreter-chiffrage) :', texteBrut);
      throw new Error("L'analyse n'a pas pu être interprétée.");
    }

    // Filtre défensif : ne garde que les métiers demandés, avec des valeurs
    // du bon type — une réponse mal formée ne doit jamais casser le formulaire.
    const tarifsValides = {};
    metiersConnus.forEach(m => {
      const t = tarifs && typeof tarifs === 'object' ? tarifs[m] : null;
      if (!t || typeof t !== 'object') return;
      tarifsValides[m] = {
        unite: UNITES_VALIDES.includes(t.unite) ? t.unite : 'forfait',
        prix: typeof t.prix === 'number' && isFinite(t.prix) ? t.prix : null,
        minimum: typeof t.minimum === 'number' && isFinite(t.minimum) ? t.minimum : null,
        note: typeof t.note === 'string' && t.note.trim() ? t.note.trim() : null,
      };
    });

    return res.status(200).json({ success: true, tarifs: tarifsValides });
  } catch (err) {
    console.error('Erreur interpreter-chiffrage :', err);
    return res.status(500).json({ success: false, error: "L'analyse n'est pas disponible pour le moment." });
  }
}
