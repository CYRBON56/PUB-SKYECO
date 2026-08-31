// /api/classifier-projet-formulaire.js
// Appelé par public/apercu.html juste après que le prospect a décrit son
// projet (étape "Décrivez votre projet en quelques mots"). Détermine si ce
// projet est automatiquement chiffrable : correspond-il à l'un des
// "produits" que l'ARTISAN a lui-même définis à l'avance (colonne
// produits_chiffrables, remplie depuis mes-elements.html via
// api/analyser-produits-chiffrables.js) ?
//
// Remplace api/selectionner-questions-formulaire.js (retiré) — même garde-fou
// de sécurité, étendu au choix du produit lui-même :
//
// Règle de sécurité impérative : l'IA ne peut JAMAIS faire apparaître un
// produit ou une question absents de ce que l'artisan a validé à l'avance —
// sa réponse n'est utilisée que pour choisir des identifiants, filtrés
// ensuite contre la vraie liste. Si le projet ne correspond à aucun produit
// (ou si l'artisan n'en a configuré aucun), le projet n'est simplement pas
// chiffrable automatiquement — le prospect est alors routé vers la prise de
// rendez-vous avec un technicien (public/prendre-rdv.html), jamais bloqué.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY

const SYSTEM_PROMPT = `Un prospect décrit un projet de travaux à un artisan du BTP/paysagisme en France. Voici la liste des "produits" chiffrables que l'artisan propose — chacun avec un identifiant, un nom, et ses propres questions de devis (elles aussi avec un identifiant).

Ta tâche, en deux temps :
1. Choisis, parmi CETTE liste de produits uniquement, celui qui correspond le mieux au projet décrit — UNIQUEMENT s'il y a un rapport clair et direct (par exemple, un produit "Pose de clôture" n'est pertinent que si le projet parle bien de clôture). S'il n'y a pas de correspondance claire, réponds null pour "produitId" — ne force jamais une correspondance approximative.
2. Si tu as choisi un produit, choisis aussi, PARMI les questions de CE produit uniquement, celles pertinentes pour ce projet précis (généralement entre 0 et 5).

Réponds UNIQUEMENT avec un objet JSON, sans aucun texte avant ou après, sans balises markdown, selon ce schéma exact :
{"produitId": "id-du-produit"|null, "questionIds": ["id1","id2"]}
Si "produitId" est null, "questionIds" doit être un tableau vide.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, description } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=produits_chiffrables`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const produits = Array.isArray(draftRows[0]?.produits_chiffrables) ? draftRows[0].produits_chiffrables : [];

    // Aucun produit configuré par l'artisan, ou pas de description
    // exploitable -> pas d'appel IA inutile, le projet n'est simplement pas
    // chiffrable automatiquement (comportement safe par défaut).
    if (!produits.length || !description || typeof description !== 'string' || !description.trim()) {
      return res.status(200).json({ success: true, chiffrable: false });
    }

    const produitsParId = new Map(produits.map(p => [p.id, p]));
    const listePourIA = produits.map(p => {
      const questions = (Array.isArray(p.questions) ? p.questions : [])
        .map(q => `    - id="${q.id}" : ${q.label}`).join('\n');
      return `- id="${p.id}" : ${p.nom}${questions ? '\n' + questions : ''}`;
    }).join('\n');

    const contexte = `Liste des produits disponibles :\n${listePourIA}\n\nDescription du projet par le prospect : ${description.trim().substring(0, 800)}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contexte }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(detail);
    }

    const data = await resp.json();
    let texte = (data.content?.[0]?.text || '').trim();
    texte = texte.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let choix;
    try {
      choix = JSON.parse(texte);
    } catch (e) {
      choix = { produitId: null, questionIds: [] };
    }
    if (!choix || typeof choix !== 'object') choix = { produitId: null, questionIds: [] };

    // Sanitize impérative : le produit doit réellement exister dans la liste
    // de l'artisan.
    const produit = (typeof choix.produitId === 'string' && produitsParId.has(choix.produitId))
      ? produitsParId.get(choix.produitId)
      : null;

    if (!produit) {
      return res.status(200).json({ success: true, chiffrable: false });
    }

    // Sanitize impérative : les questions retenues doivent appartenir à CE
    // produit précis (pas un autre), dans l'ordre défini par l'artisan.
    const idsQuestionsChoisis = new Set(Array.isArray(choix.questionIds) ? choix.questionIds : []);
    const questionsProduit = Array.isArray(produit.questions) ? produit.questions : [];
    const questions = questionsProduit.filter(q => idsQuestionsChoisis.has(q.id));

    return res.status(200).json({
      success: true,
      chiffrable: true,
      produit: {
        id: produit.id,
        nom: produit.nom,
        unite: produit.unite,
        prix: produit.prix,
        minimum: produit.minimum,
      },
      questions,
    });
  } catch (err) {
    console.error('Erreur classifier-projet-formulaire :', err);
    // Ne bloque jamais le prospect : en cas d'échec, le projet est
    // simplement considéré non chiffrable automatiquement (routage vers la
    // prise de rendez-vous technicien, jamais un blocage).
    return res.status(200).json({ success: true, chiffrable: false });
  }
}
