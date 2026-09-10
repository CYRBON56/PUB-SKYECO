// /api/chat-skyeco.js
// Chatbot IA (Claude) répondant aux questions des visiteurs sur Skyeco Pro,
// directement sur les pages du tunnel de conversion.
//
// Variable d'environnement requise :
//   ANTHROPIC_API_KEY (à créer sur console.anthropic.com)
//
// Variables déjà présentes ailleurs, réutilisées ici pour le rate limiting :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { ipDepuisRequete, verifierLimite } from './_lib/rate-limit.js';

const SYSTEM_PROMPT = `Tu es l'assistant de Skyeco Pro, un service qui crée gratuitement des sites vitrines avec formulaire d'estimation pour les artisans du paysagisme et du BTP en France (paysagistes, poseurs de piscine, élagueurs, entreprises d'entretien d'espaces verts...).

Voici ce que tu dois savoir pour répondre :

COMMENT ÇA MARCHE :
1. L'artisan remplit un court formulaire (métier, zone d'intervention) et voit un aperçu générique gratuit en quelques minutes.
2. Il réserve un appel téléphonique gratuit et sans engagement pour qu'on construise sa vraie vitrine personnalisée (logo, photos, coordonnées).
3. Une fois sa vraie vitrine prête, il la valide et choisit une formule.
4. Il peut ensuite financer des campagnes Google Ads pour recevoir des demandes de devis de vrais clients.

LA FORMULE (prix HT/mois, sans engagement) — une seule formule, tout compris :
- Formulaire vitrine en ligne + tableau de bord complet pour piloter la publicité (clics, coûts, mots-clés).
- Visualisation détaillée des demandes de devis reçues + possibilité d'envoyer un SMS pour proposer un rendez-vous.
- Envoi de devis avec signature électronique par SMS + relances automatiques avec offres.
- Tarif : 39,90€ HT/mois pendant les 12 premiers mois (offre de lancement, appliquée automatiquement), puis 79,90€ HT/mois ensuite.

POINTS IMPORTANTS :
- La création du site est gratuite dans tous les cas — l'abonnement démarre seulement une fois que l'artisan valide sa vraie vitrine.
- Sans engagement : résiliable à tout moment, ou pause possible 1 mois sans prélèvement.
- Le budget publicitaire (Google Ads) est séparé de l'abonnement — une commission de service de 30% est prélevée sur le montant HT (hors TVA), le reste finance vraiment les clics sur Google Ads.
- Le budget publicitaire n'est pas garanti sur un mois fixe : il est consommé au rythme réel des clics reçus.

TON :
Réponds toujours en français, de façon chaleureuse, concise et directe — comme un humain qui connaît bien le produit, pas un robot corporate. Si tu ne sais pas répondre à une question précise (ex: un cas très spécifique), invite la personne à réserver l'appel gratuit ou à demander à être rappelée plutôt que d'inventer une réponse.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages manquant ou invalide' });
  }

  // Sécurité (06/09/2026) : ce endpoint public appelle l'API Anthropic
  // (payante) sans aucune limite — un appel en boucle, ou avec un
  // "messages" volumineux, pouvait faire grimper la facture sans contrôle.
  // Limite par IP + plafond de taille/longueur de conversation, en plus du
  // max_tokens déjà fixé sur la réponse.
  if (messages.length > 20) {
    return res.status(400).json({ error: 'Conversation trop longue.' });
  }
  const tailleTotale = messages.reduce((n, m) => n + String(m?.content || '').length, 0);
  if (tailleTotale > 8000) {
    return res.status(400).json({ error: 'Message trop long.' });
  }

  const ip = ipDepuisRequete(req);
  const autorise = await verifierLimite(`chat-skyeco:ip:${ip}`, 20, 10 * 60);
  if (!autorise) {
    return res.status(429).json({ error: 'Trop de messages envoyés. Merci de patienter quelques minutes.' });
  }

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
        messages: messages, // [{ role: 'user'|'assistant', content: '...' }, ...]
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail);
    }

    const data = await resp.json();
    const reponseTexte = data.content?.[0]?.text || "Désolé, je n'ai pas pu répondre pour le moment.";

    return res.status(200).json({ success: true, reponse: reponseTexte });
  } catch (err) {
    console.error('Erreur chat-skyeco :', err);
    return res.status(500).json({ success: false, error: "Le chat n'est pas disponible pour le moment." });
  }
}
