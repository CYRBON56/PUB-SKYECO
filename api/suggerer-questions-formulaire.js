// /api/suggerer-questions-formulaire.js
// Suggestions de questions de devis générées par IA (Claude) à partir d'une
// description libre de l'activité de l'artisan. Utilisé par mes-elements.html
// (section "📋 Créer vos formulaires") : l'artisan coche celles qu'il veut
// garder dans son "pool" de questions plutôt que de tout écrire lui-même.
//
// Ce pool sert ensuite de base à api/selectionner-questions-formulaire.js,
// qui choisit un sous-ensemble pertinent selon le projet décrit par CHAQUE
// prospect — mais ne peut jamais proposer une question absente de ce pool.
//
// Variable d'environnement requise :
//   ANTHROPIC_API_KEY (déjà utilisée par chat-skyeco.js et suggerer-mots-cles.js)

const TYPES_VALIDES = ['nombre', 'texte', 'case'];
const UNITES_VALIDES = ['ml', 'm2', 'm3'];

const SYSTEM_PROMPT = `Tu aides un artisan du BTP ou du paysagisme en France (résine/revêtements de sol, clôtures, terrassement, assainissement, paysagisme, piscine, élagage, etc.) à préparer les questions qu'il veut poser à ses futurs clients quand ils demandent un devis en ligne.

L'artisan te décrit son activité. Ta tâche : proposer 6 à 12 questions courtes et concrètes qui aideraient à cerner un projet et donner une enveloppe budgétaire (jamais un prix ferme). Pense notamment aux questions de mesure quand elles ont du sens pour ce métier (mètres linéaires pour une clôture, mètres carrés pour une terrasse/un revêtement de sol, volume/m³ pour du terrassement), mais aussi à d'autres questions utiles (état du support existant, accès chantier, matériau souhaité, etc.).

Réponds UNIQUEMENT avec un tableau JSON d'objets, sans aucun texte avant ou après, sans balises markdown. Chaque objet a exactement ces clés :
- "label" : la question, formulée simplement, en français (ex: "Combien de mètres linéaires de clôture ?")
- "type" : "nombre" (réponse chiffrée), "texte" (réponse courte en texte libre), ou "case" (question fermée oui/non)
- "unite" : uniquement si type="nombre" et qu'une unité de mesure a du sens — "ml" (mètres linéaires), "m2" (mètres carrés) ou "m3" (volume) ; sinon null

Exemple exact de format : [{"label":"Combien de mètres linéaires de clôture ?","type":"nombre","unite":"ml"},{"label":"Le terrain est-il déjà clôturé en partie ?","type":"case","unite":null}]`;

function genererId(label, index) {
  const slug = label
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  return `${slug || 'question'}-${index}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { description, metier } = req.body || {};
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ success: false, error: 'Merci de décrire votre activité.' });
  }

  const contexte = [
    `Description donnée par l'artisan : ${description.trim().substring(0, 800)}`,
    metier ? `Métier renseigné sur son profil : ${Array.isArray(metier) ? metier.join(', ') : metier}` : null,
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
        max_tokens: 700,
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
    texte = texte.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let brut;
    try {
      brut = JSON.parse(texte);
    } catch (e) {
      throw new Error('Réponse IA illisible.');
    }
    if (!Array.isArray(brut)) throw new Error('Format de réponse IA invalide.');

    const questions = brut
      .filter(q => q && typeof q.label === 'string' && q.label.trim())
      .map((q, i) => {
        const type = TYPES_VALIDES.includes(q.type) ? q.type : 'texte';
        const unite = type === 'nombre' && UNITES_VALIDES.includes(q.unite) ? q.unite : null;
        const label = q.label.trim().substring(0, 120);
        return { id: genererId(label, i), label, type, unite };
      })
      .slice(0, 12);

    if (!questions.length) throw new Error("L'IA n'a proposé aucune question exploitable.");

    return res.status(200).json({ success: true, questions });
  } catch (err) {
    console.error('Erreur suggerer-questions-formulaire :', err);
    return res.status(500).json({ success: false, error: "Impossible de générer des suggestions pour le moment." });
  }
}
