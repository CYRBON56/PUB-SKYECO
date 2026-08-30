// /api/suggerer-mots-cles.js
// Suggestions de mots-clés Google Ads générées par IA (Claude) à partir
// d'une description libre de son métier et de ce que l'artisan veut mettre
// en avant. Utilisé par campagne.html avant la création de la campagne :
// l'artisan coche ceux qu'il veut garder plutôt que de subir une liste figée.
//
// Variable d'environnement requise :
//   ANTHROPIC_API_KEY (déjà utilisée par chat-skyeco.js)

const SYSTEM_PROMPT = `Tu es un expert en Google Ads pour des artisans du BTP et du paysagisme en France (paysagistes, poseurs de piscine, élagueurs, entretien d'espaces verts, terrassement, résine/revêtements de sol, etc.).

Un artisan te décrit son métier et ce qu'il veut mettre en avant pour attirer des prospects. Ta tâche : proposer une liste de 10 à 15 mots-clés Google Ads pertinents.

Règles :
- Mots-clés courts (2 à 5 mots), réalistes, à forte intention commerciale — ce que tape quelqu'un qui cherche activement un devis ou un prix, pas des mots-clés génériques ou informatifs.
- Inclure des variantes avec "prix", "devis", "pas cher" quand ça a du sens.
- Si une zone géographique est donnée, inclure 2-3 mots-clés avec cette zone.
- En français, adaptés à une recherche Google réelle en France.
- Réponds UNIQUEMENT avec un tableau JSON de chaînes de caractères, sans aucun texte avant ou après, sans balises markdown. Exemple exact de format : ["terrasse composite prix", "devis terrasse bois", "pose terrasse composite Brech"]`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { description, metier, zone } = req.body || {};
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ success: false, error: 'Merci de décrire votre activité.' });
  }

  const contexte = [
    `Description donnée par l'artisan : ${description.trim().substring(0, 800)}`,
    metier ? `Métier renseigné sur son profil : ${Array.isArray(metier) ? metier.join(', ') : metier}` : null,
    zone ? `Zone d'intervention : ${zone}` : null,
  ].filter(Boolean).join('\n');

  try {
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
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contexte }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail);
    }

    const data = await resp.json();
    let texte = (data.content?.[0]?.text || '').trim();
    // Au cas où le modèle enveloppe quand même sa réponse dans des balises markdown.
    texte = texte.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let motsCles;
    try {
      motsCles = JSON.parse(texte);
    } catch (e) {
      throw new Error('Réponse IA illisible.');
    }
    if (!Array.isArray(motsCles)) throw new Error('Format de réponse IA invalide.');

    motsCles = motsCles
      .filter(m => typeof m === 'string' && m.trim())
      .map(m => m.trim().substring(0, 80))
      .slice(0, 15);

    if (!motsCles.length) throw new Error("L'IA n'a proposé aucun mot-clé exploitable.");

    return res.status(200).json({ success: true, motsCles });
  } catch (err) {
    console.error('Erreur suggerer-mots-cles :', err);
    return res.status(500).json({ success: false, error: "Impossible de générer des suggestions pour le moment." });
  }
}
