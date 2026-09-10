// /api/generer-vitrine-depuis-site.js
// Va chercher le contenu du site web existant d'un artisan (URL fournie
// dans mes-elements.html, section "Site web existant"), et en tire :
//   - un titre d'accroche pensé pour donner envie de demander un devis
//     (même esprit que suggerer-titre.js, mais nourri par le vrai contenu
//     du site plutôt que seulement le métier générique)
//   - une liste de photos candidates trouvées sur ce site, que l'artisan
//     peut ensuite choisir d'importer dans son carrousel (voir
//     api/importer-photo-externe.js pour le téléchargement effectif)
//
// Rien n'est enregistré ni importé automatiquement ici — l'artisan valide
// ce qu'il garde, comme pour le reste des suggestions IA de ce formulaire.
//
// Variable d'environnement requise :
//   ANTHROPIC_API_KEY (même clé que api/suggerer-titre.js)

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

const EXTENSIONS_IMAGE = /\.(jpe?g|png|webp)(\?|#|$)/i;
const MOTS_EXCLUS = /(logo|icon|favicon|sprite|pixel|avatar)/i;

function resoudreUrl(src, base) {
  try {
    return new URL(src, base).toString();
  } catch (e) {
    return null;
  }
}

function extraireImages(html, baseUrl) {
  const urls = new Set();
  const regex = /<img[^>]+src=["']([^"'>]+)["']/gi;
  let match;
  while ((match = regex.exec(html)) && urls.size < 40) {
    const resolue = resoudreUrl(match[1], baseUrl);
    if (!resolue) continue;
    if (!EXTENSIONS_IMAGE.test(resolue)) continue;
    if (MOTS_EXCLUS.test(resolue)) continue;
    urls.add(resolue);
  }
  return Array.from(urls).slice(0, 12);
}

function construirePrompt(texteSite, metiers, zone) {
  const listeMetiers = metiers.length ? metiers.map(m => METIER_LABELS[m] || m).join(', ') : 'non précisé';
  const zoneTexte = zone ? ` Secteur d'intervention : ${zone}.` : '';

  return `Voici le texte brut extrait du site web actuel d'un artisan français du BTP/paysagisme (balises HTML retirées, peut contenir du bruit de navigation/menu — ignore-le) :
"""
${texteSite}
"""

Métier(s) connu(s) de cet artisan : ${listeMetiers}.${zoneTexte}

À partir du contenu réel de ce site (ce que l'artisan met en avant, son ton, ses points forts), écris pour sa nouvelle page vitrine :
1. "titre" : un titre d'accroche court (4 à 9 mots), concret, qui donne confiance et donne envie de demander un devis. Pas de formule creuse.
2. "description" : un paragraphe court (2 à 3 phrases, 40 mots maximum), qui reprend ce qui rend cet artisan crédible/différent d'après son site, et se termine par une incitation naturelle à demander un devis ou laisser ses coordonnées.

Réponds STRICTEMENT en JSON valide, sans aucun texte avant ou après, sous cette forme exacte :
{ "titre": "...", "description": "..." }`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { url: urlBrute, metiers, zone } = req.body || {};
  if (!urlBrute) {
    return res.status(400).json({ success: false, error: 'URL manquante' });
  }
  const url = /^https?:\/\//i.test(urlBrute) ? urlBrute : `https://${urlBrute}`;
  const metiersConnus = Array.isArray(metiers) ? metiers.filter(m => Object.prototype.hasOwnProperty.call(METIER_LABELS, m)) : [];

  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SkyecoProBot)' } });
    if (!resp.ok) {
      return res.status(200).json({ success: false, error: "Impossible d'accéder à cette page." });
    }
    const html = await resp.text();
    const texte = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
    const images = extraireImages(html, url);

    if (!texte) {
      return res.status(200).json({ success: false, error: "Cette page ne contient pas assez de texte à analyser.", images });
    }

    const prompt = construirePrompt(texte, metiersConnus, zone);

    const respIA = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!respIA.ok) {
      const detail = await respIA.text();
      throw new Error(detail);
    }
    const dataIA = await respIA.json();
    const texteBrut = (dataIA.content || []).map(b => (b.type === 'text' ? b.text : '')).join('').trim();
    const nettoye = texteBrut.replace(/```json|```/g, '').trim();
    const resultat = JSON.parse(nettoye);

    return res.status(200).json({
      success: true,
      titre: typeof resultat.titre === 'string' ? resultat.titre.trim() : null,
      description: typeof resultat.description === 'string' ? resultat.description.trim() : null,
      images,
    });
  } catch (err) {
    console.error('Erreur generer-vitrine-depuis-site :', err);
    return res.status(200).json({ success: false, error: "Cette page n'a pas pu être analysée pour le moment." });
  }
}
