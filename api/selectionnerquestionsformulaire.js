// /api/selectionner-questions-formulaire.js
// Appelé par public/apercu.html juste après que le prospect a décrit son
// projet (étape "Décrivez votre projet en quelques mots"). Sélectionne, PARMI
// les questions que l'ARTISAN a lui-même validées à l'avance (colonne
// formulaire_questions_pool, remplie depuis mes-elements.html via
// api/suggerer-questions-formulaire.js), le sous-ensemble pertinent pour ce
// projet précis.
//
// Règle de sécurité impérative : l'IA ne peut JAMAIS faire apparaître une
// question absente du pool de l'artisan — sa réponse n'est utilisée que pour
// choisir des identifiants, filtrés ensuite contre la vraie liste. Aucun
// texte généré à la volée n'atteint jamais le prospect sans validation
// préalable de l'artisan.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY

const SYSTEM_PROMPT = `Un prospect décrit un projet de travaux à un artisan du BTP/paysagisme en France. Voici la liste des questions de devis que l'artisan a préparées à l'avance, chacune avec un identifiant.

Ta tâche : choisir, parmi CETTE liste uniquement, les identifiants des questions pertinentes pour CE projet précis (généralement entre 1 et 5). N'inclus que celles qui ont un rapport clair avec ce qui est décrit — par exemple une question sur les mètres linéaires de clôture n'est pertinente que si le projet parle bien de clôture.

Réponds UNIQUEMENT avec un tableau JSON d'identifiants (chaînes de caractères), sans aucun texte avant ou après, sans balises markdown. Exemple exact de format : ["cloture-longueur-0","acces-chantier-3"]. Si aucune question de la liste n'est pertinente, réponds [].`;

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
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=formulaire_questions_pool`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const pool = Array.isArray(draftRows[0]?.formulaire_questions_pool) ? draftRows[0].formulaire_questions_pool : [];

    // Pas de pool configuré par l'artisan, ou pas de description exploitable
    // -> pas d'appel IA inutile, le formulaire continue avec ses questions
    // habituelles (comportement strictement identique à avant cette
    // fonctionnalité).
    if (!pool.length || !description || typeof description !== 'string' || !description.trim()) {
      return res.status(200).json({ success: true, questions: [] });
    }

    const poolIds = new Set(pool.map(q => q.id));
    const listePourIA = pool.map(q => `- id="${q.id}" : ${q.label}`).join('\n');
    const contexte = `Liste des questions disponibles :\n${listePourIA}\n\nDescription du projet par le prospect : ${description.trim().substring(0, 800)}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
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

    let idsChoisis;
    try {
      idsChoisis = JSON.parse(texte);
    } catch (e) {
      idsChoisis = [];
    }
    if (!Array.isArray(idsChoisis)) idsChoisis = [];

    // Sanitize impérative : ne garder que des ids qui existent réellement
    // dans le pool de l'artisan, dans l'ordre du pool (pas celui renvoyé par
    // l'IA, pour rester prévisible).
    const idsRetenus = new Set(idsChoisis.filter(id => poolIds.has(id)));
    const questions = pool.filter(q => idsRetenus.has(q.id));

    return res.status(200).json({ success: true, questions });
  } catch (err) {
    console.error('Erreur selectionner-questions-formulaire :', err);
    // Ne bloque jamais le prospect : en cas d'échec, on continue simplement
    // sans question dynamique supplémentaire.
    return res.status(200).json({ success: true, questions: [] });
  }
}
