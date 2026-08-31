// /api/analyser-produits-chiffrables.js
// Remplace api/interpreter-chiffrage.js + api/suggerer-questions-formulaire.js
// (tous deux retirés). Utilisé par mes-elements.html (section "🧮 Produits
// chiffrables") : l'artisan décrit librement ce qu'il facture, et l'IA en
// déduit une liste de "produits" chiffrables — chacun avec son unité de
// facturation (m²/ml/m³/forfait), un prix et un minimum si déductibles du
// texte, et quelques questions de devis pertinentes pour CE produit précis.
//
// Ces produits servent ensuite de base à api/classifier-projet-formulaire.js,
// qui choisit lequel (s'il y en a un) correspond au projet décrit par CHAQUE
// prospect — mais ne peut jamais en inventer un nouveau ni inventer de
// question absente de la liste ici produite.
//
// Variable d'environnement requise :
//   ANTHROPIC_API_KEY (déjà utilisée par chat-skyeco.js et suggerer-mots-cles.js)

const UNITES_VALIDES = ['m2', 'ml', 'm3', 'forfait'];
const TYPES_VALIDES = ['nombre', 'texte', 'case'];

const SYSTEM_PROMPT = `Tu aides un artisan du BTP ou du paysagisme en France (résine/revêtements de sol, clôtures, terrassement, assainissement, paysagisme, piscine, élagage, etc.) à structurer ce qu'il facture, pour construire un formulaire de devis en ligne.

L'artisan te décrit librement son activité et comment il facture. Ta tâche : identifier les différents "produits" ou prestations distinctes qu'il propose (par exemple, pour un poseur de sol : "Résine EPDM" et "Dalles PVC" pourraient être deux produits séparés, avec des prix différents). Pour CHAQUE produit identifié, donne :
- "nom" : nom court de la prestation (ex: "Enrobés", "Pose de clôture")
- "metier" : le métier concerné, EXACTEMENT une des clés fournies dans la liste des métiers de l'artisan
- "unite" : "m2" (surface), "ml" (mètre linéaire), "m3" (volume), ou "forfait" (prix fixe, ni surface ni longueur ni volume)
- "prix" : le prix unitaire HT en euros, en nombre (ex: 45), sans symbole € ; null si non déductible du texte
- "minimum" : le minimum facturé en euros HT, en nombre ; null si non mentionné
- "questions" : 2 à 6 questions courtes et concrètes utiles pour cerner CE produit précis (état du support existant, matériau souhaité, accès chantier, etc. — PAS la question de quantité/surface, celle-ci est ajoutée automatiquement), chacune avec :
  - "label" : la question en français
  - "type" : "nombre" (réponse chiffrée), "texte" (réponse courte libre), ou "case" (oui/non)
  - "unite" : uniquement si type="nombre" et qu'une unité de mesure a du sens — "ml", "m2" ou "m3" ; sinon null

N'invente aucun prix qui n'est pas dans le texte ou clairement déductible. Si l'artisan ne décrit qu'une seule façon de facturer, renvoie un seul produit. Identifie entre 1 et 8 produits selon ce que décrit réellement le texte — jamais plus qu'il n'y a de prestations réellement distinctes.

Réponds UNIQUEMENT avec un tableau JSON d'objets, sans aucun texte avant ou après, sans balises markdown. Exemple exact de format :
[{"nom":"Enrobés","metier":"resine","unite":"m2","prix":45,"minimum":300,"questions":[{"label":"Quel est le support actuel (dalle, terre, autre) ?","type":"texte","unite":null},{"label":"Combien de mètres carrés à recouvrir ?","type":"nombre","unite":"m2"}]}]`;

function genererId(nom, index) {
  const slug = String(nom || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  return `${slug || 'produit'}-${index}`;
}

function genererIdQuestion(label, indexProduit, indexQuestion) {
  const slug = String(label || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30);
  return `${slug || 'question'}-${indexProduit}-${indexQuestion}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { description, metiers } = req.body || {};
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ success: false, error: 'Merci de décrire votre activité.' });
  }
  if (!Array.isArray(metiers) || metiers.length === 0) {
    return res.status(400).json({ success: false, error: 'Aucun métier fourni.' });
  }

  const contexte = [
    `Métiers renseignés sur le profil de l'artisan (utilise EXACTEMENT une de ces clés pour "metier") : ${metiers.join(', ')}`,
    `Description donnée par l'artisan : ${description.trim().substring(0, 2000)}`,
  ].join('\n');

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
        max_tokens: 2000,
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

    const metiersConnus = new Set(metiers);

    const produits = brut
      .filter(p => p && typeof p.nom === 'string' && p.nom.trim())
      .map((p, i) => {
        const nom = p.nom.trim().substring(0, 80);
        const metier = metiersConnus.has(p.metier) ? p.metier : metiers[0];
        const unite = UNITES_VALIDES.includes(p.unite) ? p.unite : 'forfait';
        const prix = typeof p.prix === 'number' && isFinite(p.prix) ? p.prix : null;
        const minimum = typeof p.minimum === 'number' && isFinite(p.minimum) ? p.minimum : null;
        const questionsBrutes = Array.isArray(p.questions) ? p.questions : [];
        const questions = questionsBrutes
          .filter(q => q && typeof q.label === 'string' && q.label.trim())
          .map((q, j) => {
            const type = TYPES_VALIDES.includes(q.type) ? q.type : 'texte';
            const uniteQ = type === 'nombre' && UNITES_VALIDES.includes(q.unite) && q.unite !== 'forfait' ? q.unite : null;
            const label = q.label.trim().substring(0, 120);
            return { id: genererIdQuestion(label, i, j), label, type, unite: uniteQ };
          })
          .slice(0, 6);
        return { id: genererId(nom, i), nom, metier, unite, prix, minimum, questions };
      })
      .slice(0, 8);

    if (!produits.length) throw new Error("L'IA n'a identifié aucun produit exploitable.");

    return res.status(200).json({ success: true, produits });
  } catch (err) {
    console.error('Erreur analyser-produits-chiffrables :', err);
    return res.status(500).json({ success: false, error: "Impossible d'analyser votre activité pour le moment — vous pouvez ajouter vos produits manuellement." });
  }
}
