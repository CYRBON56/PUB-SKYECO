// /api/suggerer-mots-cles.js
// Suggestions de mots-clés Google Ads générées par IA (Claude) à partir
// d'une description libre de son métier ET/OU de l'adresse de son site web
// actuel (le serveur va lire son contenu — voir extraireTexteSite ci-dessous).
// Utilisé par mon-dashboard.html (section "✨ Quels mots-clés pour votre
// annonce ?") avant la création de la campagne : l'artisan coche ceux qu'il
// veut garder plutôt que de subir une liste figée.
//
// Variable d'environnement requise :
//   ANTHROPIC_API_KEY (déjà utilisée par chat-skyeco.js)

const SYSTEM_PROMPT = `Tu es un expert en Google Ads pour des artisans du BTP et du paysagisme en France (paysagistes, poseurs de piscine, élagueurs, entretien d'espaces verts, terrassement, résine/revêtements de sol, etc.).

Un artisan te décrit son métier et ce qu'il veut mettre en avant pour attirer des prospects — parfois via une description écrite, parfois via le contenu extrait de son site web actuel, parfois les deux. Ta tâche : proposer une liste de 10 à 15 mots-clés Google Ads pertinents.

Règles :
- Mots-clés courts (2 à 5 mots), réalistes, à forte intention commerciale — ce que tape quelqu'un qui cherche activement un devis ou un prix, pas des mots-clés génériques ou informatifs.
- Si le contenu vient d'un site web, ignore tout ce qui n'est pas lié à l'activité elle-même (menu de navigation, mentions légales, cookies, liens de réseaux sociaux) et concentre-toi sur les prestations, produits et zones géographiques réellement mis en avant.
- Inclure des variantes avec "prix", "devis", "pas cher" quand ça a du sens.
- Si une zone géographique est donnée ou identifiée dans le site, inclure 2-3 mots-clés avec cette zone.
- En français, adaptés à une recherche Google réelle en France.
- Réponds UNIQUEMENT avec un tableau JSON de chaînes de caractères, sans aucun texte avant ou après, sans balises markdown. Exemple exact de format : ["terrasse composite prix", "devis terrasse bois", "pose terrasse composite Brech"]`;

// Récupère le HTML d'un site et en extrait un texte brut exploitable par
// l'IA — pas de dépendance externe (pas de parseur HTML complet), juste un
// nettoyage suffisant pour ce cas d'usage : scripts/styles/commentaires
// retirés, balises remplacées par des espaces ou des retours à la ligne,
// quelques entités HTML courantes décodées, tronqué à 4000 caractères pour
// rester raisonnable en tokens. Abandonne après 8 secondes si le site ne
// répond pas.
async function extraireTexteSite(urlBrute) {
  let url = urlBrute.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SkyecoProBot/1.0; +https://skyeco.fr)' },
    });
    if (!resp.ok) throw new Error(`Site inaccessible (HTTP ${resp.status})`);
    const contentType = resp.headers.get('content-type') || '';
    if (contentType && !contentType.includes('html')) throw new Error("Ce n'est pas une page web (contenu non HTML).");

    const html = await resp.text();
    const texte = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|br|section|article|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&eacute;|&#233;/gi, 'é').replace(/&egrave;|&#232;/gi, 'è').replace(/&agrave;|&#224;/gi, 'à')
      .replace(/&ccedil;|&#231;/gi, 'ç').replace(/&ecirc;|&#234;/gi, 'ê').replace(/&ocirc;|&#244;/gi, 'ô')
      .replace(/&ugrave;|&#249;/gi, 'ù').replace(/&icirc;|&#238;/gi, 'î')
      .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();

    if (!texte) throw new Error("Le site n'a renvoyé aucun contenu exploitable.");
    return texte.substring(0, 4000);
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { description, metier, zone, siteUrl } = req.body || {};
  const descriptionTrim = typeof description === 'string' ? description.trim() : '';
  const siteUrlTrim = typeof siteUrl === 'string' ? siteUrl.trim() : '';

  if (!descriptionTrim && !siteUrlTrim) {
    return res.status(400).json({ success: false, error: 'Merci de décrire votre activité ou d\'indiquer l\'adresse de votre site.' });
  }

  let contenuSite = null;
  let erreurSite = null;
  if (siteUrlTrim) {
    try {
      contenuSite = await extraireTexteSite(siteUrlTrim);
    } catch (e) {
      erreurSite = e.name === 'AbortError' ? "le site n'a pas répondu à temps" : (e.message || 'impossible de lire ce site');
    }
  }

  // Site fourni mais illisible, et aucune description en repli : on prévient
  // l'artisan plutôt que de générer des mots-clés génériques hors sujet.
  if (siteUrlTrim && erreurSite && !descriptionTrim) {
    return res.status(200).json({ success: false, error: `Impossible de lire ${siteUrlTrim} (${erreurSite}) — décrivez votre activité manuellement, ou vérifiez l'adresse.` });
  }

  const contexte = [
    descriptionTrim ? `Description donnée par l'artisan : ${descriptionTrim.substring(0, 800)}` : null,
    contenuSite ? `Contenu extrait du site web actuel de l'artisan (${siteUrlTrim}) :\n${contenuSite}` : null,
    (siteUrlTrim && erreurSite && descriptionTrim) ? `Note : le site ${siteUrlTrim} n'a pas pu être lu (${erreurSite}) — base-toi uniquement sur la description ci-dessus.` : null,
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

    return res.status(200).json({
      success: true,
      motsCles,
      avertissement: (siteUrlTrim && erreurSite && descriptionTrim)
        ? `Le site ${siteUrlTrim} n'a pas pu être lu (${erreurSite}) — suggestions basées sur votre description.`
        : null,
    });
  } catch (err) {
    console.error('Erreur suggerer-mots-cles :', err);
    return res.status(500).json({ success: false, error: "Impossible de générer des suggestions pour le moment." });
  }
}
