// /api/assistant-document-qa.js
// 16/11/2026 — Dans l'onglet "Assistant" de Mon Assistant Pro, l'artisan peut
// joindre un document (devis, facture, photo de chantier, contrat...) à la
// conversation et poser une question dessus. Claude lit vraiment le document
// (PDF ou image) et répond à la question, en se basant uniquement sur son
// contenu.
//
// Variable d'environnement requise : ANTHROPIC_API_KEY (déjà utilisée par
// api/chat-skyeco.js et api/prix-travaux-analyser-devis.js sur ce projet).
//
// Entrée  : { question, fichier (base64, sans préfixe data:), media_type, nom_fichier, siret }
// Sortie  : { success, reponse } ou { success:false, error }

import { ipDepuisRequete, verifierLimite } from './_lib/rate-limit.js';

export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };

const TYPES_ACCEPTES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const TAILLE_MAX = 4_400_000; // ~4.4 Mo en base64, cohérent avec prix-travaux-analyser-devis.js

const SYSTEM_PROMPT = `Tu es l'assistant de Mon Assistant Pro, un outil qui aide les artisans (BTP, paysagisme, bâtiment) à gérer leurs devis, factures, contrats et documents de chantier au quotidien.

On te transmet un document (devis, facture, contrat, photo de chantier, document administratif...) joint par l'artisan à la conversation, ainsi que sa question.

Consignes :
- Réponds UNIQUEMENT à partir de ce qui est réellement écrit ou visible dans le document fourni. N'invente jamais un montant, une date, un nom ou une clause qui n'y figure pas.
- Si la question porte sur un élément absent du document, dis-le clairement plutôt que de supposer.
- Si le document est illisible, flou, ou ne correspond pas à ce qui est demandé, dis-le simplement et explique ce que tu peux quand même lire.
- Réponds en français, de façon directe et concrète, comme un collègue qui a le document sous les yeux — sans formules creuses ni longues introductions.
- Pour un devis ou une facture, si c'est utile à la question, tu peux citer les montants, lignes ou dates précises que tu lis.
- Reste bref : quelques phrases suffisent, sauf si la question demande explicitement une liste détaillée (ex: « liste-moi toutes les lignes »).`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { question, fichier, media_type, siret } = req.body || {};

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ success: false, error: 'Question manquante.' });
  }
  if (question.length > 2000) {
    return res.status(400).json({ success: false, error: 'Question trop longue.' });
  }
  if (!fichier || typeof fichier !== 'string') {
    return res.status(400).json({ success: false, error: 'Document manquant.' });
  }
  if (!TYPES_ACCEPTES.includes(media_type)) {
    return res.status(400).json({ success: false, error: 'Format de document non pris en charge (PDF, JPG, PNG ou WEBP uniquement).' });
  }
  if (fichier.length > TAILLE_MAX) {
    return res.status(400).json({ success: false, error: 'Document trop volumineux (4 Mo maximum).' });
  }

  // Limite par artisan (siret) quand connu, sinon par IP — évite qu'un appel
  // en boucle côté front ne fasse grimper la facture Anthropic sans contrôle.
  const cle = siret && typeof siret === 'string' && siret.trim()
    ? `assistant-doc-qa:siret:${siret.trim()}`
    : `assistant-doc-qa:ip:${ipDepuisRequete(req)}`;
  const autorise = await verifierLimite(cle, 20, 10 * 60);
  if (!autorise) {
    return res.status(429).json({ success: false, error: 'Trop de documents envoyés. Merci de patienter quelques minutes.' });
  }

  try {
    const blocDocument = media_type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type, data: fichier } }
      : { type: 'image', source: { type: 'base64', media_type, data: fichier } };

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [blocDocument, { type: 'text', text: question.trim() }],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail);
    }

    const data = await resp.json();
    const reponseTexte = data.content?.[0]?.text || "Désolé, je n'ai pas pu lire ce document pour le moment.";

    return res.status(200).json({ success: true, reponse: reponseTexte });
  } catch (err) {
    console.error('Erreur assistant-document-qa :', err);
    return res.status(500).json({ success: false, error: "Je n'ai pas pu analyser ce document pour le moment. Réessaie dans un instant." });
  }
}
