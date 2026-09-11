// /api/analyser-site-vitrine.js
// Extension de l'assistant IA "Construire ma vitrine" (mes-elements.html,
// bloc data-section="assistant-ia") — demandée par Cyrille le 11/09/2026 via
// un brief technique : au lieu de (ou en plus de) taper une description
// libre, l'artisan peut coller un lien pour générer titres + brouillon de
// formulaire + carrousel de photos.
//
// Deux modes, décision produit actée avec Cyrille :
//   - "propre_site"  : c'est SON site actuel. On récupère son texte réel ET
//     ses images (logo + quelques photos) — ce sont ses propres contenus,
//     réutilisables tels quels.
//   - "inspiration"  : c'est un site qui l'INSPIRE (souvent un concurrent).
//     On n'extrait QUE la structure (titres de section dans l'ordre,
//     présence/absence d'un formulaire) — JAMAIS le texte ni les images du
//     site source. Le prompt interdit explicitement à l'IA de citer ou
//     paraphraser le contenu original ; elle génère un contenu 100% neuf
//     pour l'activité de l'artisan à partir de cette seule structure.
//     Objectif double : éviter tout problème de droit d'auteur, et éviter un
//     contenu dupliqué qui pénaliserait le référencement Google du nouvel
//     artisan.
//
// Comme pour api/generer-vitrine-ia.js (dont ce fichier réutilise le schéma
// d'appel IA et le format de sortie), le brouillon de formulaire n'active
// RIEN automatiquement : conformément à la décision du 04/09/2026, il suit
// le circuit existant (checkFormulairePersonnalise +
// api/demander-formulaire-personnalise.js), relu et codé à la main par
// Cyrille (ou Claude sur sa demande) avant toute mise en ligne.
//
// Pas de nouvelle dépendance npm : `package.json` ne liste que
// @vercel/edge, stripe, @supabase/supabase-js, twilio (vérifié à plusieurs
// reprises sur ce projet) — donc extraction HTML par regex/DOM minimal,
// jamais via une librairie de parsing (cheerio, etc.) qui planterait au
// chargement du module faute d'être installée côté Vercel.
//
// Variables d'environnement requises : ANTHROPIC_API_KEY (même clé que
// generer-vitrine-ia.js). SUPABASE_URL/SUPABASE_ANON_KEY/BUCKET sont repris
// tels quels de mes-elements.html (clé anon publique, déjà visible
// côté client dans cette page — même convention que
// api/generer-image-gamma.js, qui héberge lui aussi des images externes
// téléchargées côté serveur avec cette même clé).

const SUPABASE_URL = 'https://wklddwumirkdjkbxvzyj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrbGRkd3VtaXJrZGprYnh2enlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMTMzNDksImV4cCI6MjA5ODc4OTM0OX0._2cVv3rmhHb-7VLTCqiMRq0F2S30NMnD8qRhTiBM7nc';
const BUCKET = 'skyeco-pro-media';

const METIER_LABELS = {
  paysagiste: 'Paysagiste',
  piscine: 'Pose piscine',
  tonte: 'Tonte et coupe',
  terrasse: 'Terrasse',
  paysagiste_concepteur: 'Paysagiste concepteur',
  arboriste: 'Arboriste élagueur',
  espaces_verts: "Entretien d'espaces verts",
  resine: 'Revêtement en résine',
  autre: 'Autre',
};

// ---------------------------------------------------------------------
// Extraction HTML minimale par regex (pas de cheerio, voir note en tête)
// ---------------------------------------------------------------------

function decoderEntitesSimples(texte) {
  return texte
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extraireBalises(html, nomBalise) {
  const regex = new RegExp(`<${nomBalise}\\b[^>]*>`, 'gi');
  return html.match(regex) || [];
}

function extraireAttribut(balise, nomAttribut) {
  const regex = new RegExp(`${nomAttribut}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = balise.match(regex);
  return m ? m[1] : null;
}

function extraireTitre(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decoderEntitesSimples(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function extraireMetaDescription(html) {
  let m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i);
  if (!m) m = html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  return m ? decoderEntitesSimples(m[1]).trim() : '';
}

function extraireSectionsTitres(html) {
  const regex = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const sections = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    const texte = decoderEntitesSimples(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (texte) sections.push(texte);
  }
  return sections;
}

function detecterFormulaire(html) {
  return /<form[\s>]/i.test(html);
}

function extraireTexteVisible(html) {
  let nettoye = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  nettoye = decoderEntitesSimples(nettoye).replace(/\s+/g, ' ').trim();
  return nettoye;
}

function resoudreUrl(possiblementRelative, base) {
  try {
    return new URL(possiblementRelative, base).toString();
  } catch {
    return null;
  }
}

function extraireLogoEtPhotos(html, baseUrl) {
  let logoCandidate = null;

  const imgs = extraireBalises(html, 'img');

  // Priorité à une vraie image de logo (alt/class/src contenant "logo") —
  // bien plus utile pour une vitrine qu'une favicon 16x16. Le premier
  // <img> correspondant dans l'ordre du document est quasi toujours celui
  // du header sur un vrai site.
  for (const tag of imgs) {
    const indices = `${extraireAttribut(tag, 'class') || ''} ${extraireAttribut(tag, 'alt') || ''} ${extraireAttribut(tag, 'src') || ''}`;
    if (/logo/i.test(indices)) {
      const src = extraireAttribut(tag, 'src') || extraireAttribut(tag, 'data-src');
      if (src) {
        logoCandidate = src;
        break;
      }
    }
  }

  // Repli : favicon déclarée en <link rel="icon">, seulement si aucune
  // vraie image de logo n'a été trouvée.
  if (!logoCandidate) {
    for (const tag of extraireBalises(html, 'link')) {
      const rel = extraireAttribut(tag, 'rel') || '';
      if (/icon/i.test(rel)) {
        const href = extraireAttribut(tag, 'href');
        if (href) {
          logoCandidate = href;
          break;
        }
      }
    }
  }

  const logoAbsolu = logoCandidate ? resoudreUrl(logoCandidate, baseUrl) : null;

  const vus = new Set(logoAbsolu ? [logoAbsolu] : []);
  const photoCandidates = [];
  for (const tag of imgs) {
    const src = extraireAttribut(tag, 'src') || extraireAttribut(tag, 'data-src');
    if (!src) continue;
    const alt = extraireAttribut(tag, 'alt') || '';
    const cls = extraireAttribut(tag, 'class') || '';
    const largeur = parseInt(extraireAttribut(tag, 'width') || '0', 10);
    const hauteur = parseInt(extraireAttribut(tag, 'height') || '0', 10);
    const indices = `${src} ${alt} ${cls}`;
    if (/logo|icon|sprite|favicon|pixel/i.test(indices)) continue;
    if (/\.svg(\?|#|$)/i.test(src)) continue;
    if ((largeur && largeur < 60) || (hauteur && hauteur < 60)) continue;
    const absolue = resoudreUrl(src, baseUrl);
    if (!absolue || vus.has(absolue)) continue;
    vus.add(absolue);
    photoCandidates.push(absolue);
    if (photoCandidates.length >= 6) break;
  }

  return { logoCandidate: logoAbsolu, photoCandidates };
}

async function telechargerEtHeberger(urlImage, draftId, prefixe) {
  const reponse = await fetch(urlImage);
  if (!reponse.ok) throw new Error('image inaccessible (' + reponse.status + ')');
  const contentType = (reponse.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^image\//i.test(contentType)) throw new Error("le fichier récupéré n'est pas une image");
  const arrayBuffer = await reponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > 8 * 1024 * 1024) throw new Error('image trop volumineuse');

  let ext = (contentType.split('/')[1] || 'jpg').toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (!/^[a-z0-9]+$/.test(ext)) ext = 'jpg';

  const nomFichier = `elements-artisan/${draftId}/${prefixe}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${nomFichier}?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': contentType,
    },
    body: buffer,
  });
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '');
    throw new Error("échec de l'hébergement de l'image : " + detail);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${nomFichier}`;
}

// ---------------------------------------------------------------------
// Construction des prompts (même schéma de sortie que generer-vitrine-ia.js)
// ---------------------------------------------------------------------

function contexteCommun(metiers, zone) {
  const listeMetiers = Array.isArray(metiers) && metiers.length
    ? metiers.map(m => METIER_LABELS[m] || m).join(', ')
    : null;
  const zoneTexte = zone ? `\nZone d'intervention : ${zone}.` : '';
  const metierTexte = listeMetiers ? `\nMétier déjà renseigné par ailleurs : ${listeMetiers}.` : '';
  return { metierTexte, zoneTexte, clesMetiers: Object.keys(METIER_LABELS).join(', ') };
}

// Format de réponse en texte à marqueurs, pas en JSON — voir l'historique
// détaillé en tête de api/generer-vitrine-ia.js (bug réel du 11/09 : un long
// texte multi-lignes plein de guillemets/ponctuation libre est fondamentalement
// mal adapté à une valeur de chaîne JSON stricte ; un texte à marqueurs n'a
// rien à échapper, donc rien à casser).
function instructionsFormatReponse(clesMetiers) {
  return `Réponds STRICTEMENT dans ce format texte brut, rien avant ni après, aucun markdown (pas de **gras**, pas de listes à puces avec *, pas de bloc \`\`\`) :

TITRE1: premier titre
TITRE2: deuxième titre
TITRE3: troisième titre
TITRE4: quatrième titre
METIER: une seule clé parmi ${clesMetiers}
###BROUILLON_DEBUT###
texte du brouillon ici, sur autant de lignes que nécessaire — guillemets, ponctuation et mise en forme libres, ce n'est pas du JSON
###BROUILLON_FIN###`;
}

const TACHES_ET_FORMAT = (clesMetiers) => `Fais trois choses :

1. Propose 4 titres d'accroche courts et percutants (entre 4 et 9 mots chacun), sur-mesure pour CET artisan précis. Donne confiance, donne envie de demander un devis — jamais de formules génériques creuses ("Votre satisfaction, notre priorité").

2. Devine le métier principal qui correspond le mieux, en choisissant EXACTEMENT une des clés suivantes : ${clesMetiers}. Si aucune ne correspond clairement, réponds "autre".

3. Rédige un BROUILLON du formulaire de devis à poser à ses futurs clients sur sa vitrine — une proposition qu'un humain (Cyrille ou une personne qu'il mandate) relira et codera lui-même avant toute mise en ligne, donc écris-le comme un cahier des charges clair et actionnable, pas comme du code :
   - une liste ordonnée de questions à poser au client, chacune avec : la question exacte, son type (choix multiple avec ses options / nombre avec son unité / texte libre), et pourquoi elle sert au calcul du prix ;
   - une explication en langage clair de la façon de calculer un prix ou une fourchette de prix à partir des réponses. Reste réaliste si aucun tarif n'est donné, en le signalant clairement ("prix à définir par l'artisan pour X") plutôt qu'en inventant des chiffres.
   Si les informations disponibles ne suffisent pas pour un métier donné, base-toi sur les pratiques courantes de ce métier en France, et signale explicitement les hypothèses faites.

${instructionsFormatReponse(clesMetiers)}`;

function construirePromptProprSite(texteExtrait, metiers, zone) {
  const { metierTexte, zoneTexte, clesMetiers } = contexteCommun(metiers, zone);
  return `Tu aides un artisan français du BTP/paysagisme à préparer sa vitrine web, destinée à ses futurs clients particuliers.

Voici le contenu de son site actuel, extrait automatiquement (peut contenir des restes de menu ou de navigation sans rapport direct, ignore-les) :
"""
${texteExtrait}
"""
${metierTexte}${zoneTexte}

${TACHES_ET_FORMAT(clesMetiers)}`;
}

function construirePromptInspiration(structure, description, metiers, zone) {
  const { metierTexte, zoneTexte, clesMetiers } = contexteCommun(metiers, zone);
  const sectionsTexte = structure.sections.length
    ? structure.sections.slice(0, 20).join(' → ')
    : '(aucune section détectée)';
  const descriptionTexte = description && description.trim()
    ? `\nVoici, avec ses propres mots, comment l'artisan décrit son activité :\n"""\n${description.trim()}\n"""\n`
    : '';

  return `Tu aides un artisan français du BTP/paysagisme à préparer sa vitrine web, destinée à ses futurs clients particuliers.

Voici la structure d'un site que l'artisan trouve inspirant pour organiser sa propre vitrine :
Sections dans l'ordre : ${sectionsTexte}
A un formulaire de contact/devis : ${structure.aForm ? 'oui' : 'non'}
${descriptionTexte}${metierTexte}${zoneTexte}

IMPORTANT : tu n'as reçu que la STRUCTURE de ce site inspirant (l'ordre de ses sections, rien d'autre) — tu n'as JAMAIS vu son texte réel. Ne reprends, ne cite et ne paraphrase de près AUCUNE phrase qui pourrait en provenir. Génère un contenu 100% original et neuf, propre à cet artisan précis. Si la description ci-dessus est absente ou trop courte, base-toi sur le(s) métier(s) déjà renseigné(s) et les pratiques courantes de ce métier en France.

${TACHES_ET_FORMAT(clesMetiers)}`;
}

function nettoyerTexteIA(texte) {
  return texte.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

// Identique à api/generer-vitrine-ia.js : découpe la réponse texte à
// marqueurs par simple recherche de motifs, sans jamais passer par
// JSON.parse — voir l'historique en tête de generer-vitrine-ia.js.
function analyserReponseTexte(texteBrut) {
  const titres = [];
  for (let i = 1; i <= 4; i++) {
    const m = texteBrut.match(new RegExp(`^TITRE${i}\\s*:\\s*(.+)$`, 'mi'));
    if (m && m[1].trim()) titres.push(nettoyerTexteIA(m[1]));
  }
  if (!titres.length) {
    throw new Error('Réponse IA illisible : ' + texteBrut.slice(0, 300));
  }

  const mMetier = texteBrut.match(/^METIER\s*:\s*(\S+)/mi);
  const clefMetier = mMetier ? mMetier[1].trim().toLowerCase().replace(/[^a-z_]/g, '') : null;
  const metierSuggere = clefMetier && Object.prototype.hasOwnProperty.call(METIER_LABELS, clefMetier)
    ? clefMetier
    : null;

  const mBrouillon = texteBrut.match(/###BROUILLON_DEBUT###([\s\S]*?)###BROUILLON_FIN###/i);
  const formulaireBrouillon = mBrouillon && mBrouillon[1].trim()
    ? nettoyerTexteIA(mBrouillon[1]).slice(0, 4000)
    : null;

  return {
    titres: titres.slice(0, 4),
    metierSuggere,
    metierSuggereLabel: metierSuggere ? METIER_LABELS[metierSuggere] : null,
    formulaireBrouillon,
  };
}

async function appellerClaude(prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
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

  return analyserReponseTexte(texteBrut);
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { url, mode, description, metiers, zone, draftId } = req.body || {};

  if (mode !== 'propre_site' && mode !== 'inspiration') {
    return res.status(400).json({ success: false, error: 'Mode invalide.' });
  }
  if (typeof url !== 'string' || url.length < 5 || url.length > 2000) {
    return res.status(400).json({ success: false, error: 'Lien manquant ou invalide.' });
  }
  let urlValidee;
  try {
    urlValidee = new URL(url);
    if (urlValidee.protocol !== 'http:' && urlValidee.protocol !== 'https:') throw new Error('protocole');
  } catch {
    return res.status(400).json({ success: false, error: 'Merci de coller un lien complet (https://...).' });
  }
  if (typeof description === 'string' && description.length > 2000) {
    return res.status(400).json({ success: false, error: 'Description trop longue (2000 caractères maximum).' });
  }

  // Étape 1 — récupération de la page, jamais côté navigateur (CORS + ne
  // pas exposer l'URL cible dans le réseau du client). Pas de rendu JS
  // headless (Playwright) : trop lourd pour un appel serverless synchrone,
  // hors scope de ce chantier — un site en JS pur qui ne rend rien côté
  // serveur tombe simplement dans le cas "site_illisible" ci-dessous.
  let html;
  try {
    const controleur = new AbortController();
    const delaiMax = setTimeout(() => controleur.abort(), 9000);
    let reponse;
    try {
      reponse = await fetch(urlValidee.toString(), {
        signal: controleur.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SkyecoProBot/1.0; +https://pub-skyeco-23ue.vercel.app)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } finally {
      clearTimeout(delaiMax);
    }
    if (!reponse.ok) throw new Error('statut HTTP ' + reponse.status);
    const contentType = reponse.headers.get('content-type') || '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      throw new Error('contenu non HTML');
    }
    html = await reponse.text();
    if (!html || html.length < 50) throw new Error('page vide');
  } catch (erreurFetch) {
    return res.status(200).json({ success: false, raison: 'site_illisible' });
  }

  const structure = {
    titre: extraireTitre(html),
    metaDescription: extraireMetaDescription(html),
    sections: extraireSectionsTitres(html),
    aForm: detecterFormulaire(html),
  };

  if (!structure.titre && !structure.sections.length && !structure.metaDescription) {
    return res.status(200).json({ success: false, raison: 'site_illisible' });
  }

  let prompt;
  let logoUrl = null;
  let photosUrls = [];

  try {
    if (mode === 'propre_site') {
      const texteVisible = extraireTexteVisible(html).slice(0, 3000);
      const texteSource = texteVisible.length > 40
        ? texteVisible
        : [structure.titre, structure.metaDescription, structure.sections.join(' — ')].filter(Boolean).join('\n');
      if (!texteSource) {
        return res.status(200).json({ success: false, raison: 'site_illisible' });
      }
      prompt = construirePromptProprSite(texteSource, metiers, zone);

      if (draftId) {
        try {
          const { logoCandidate, photoCandidates } = extraireLogoEtPhotos(html, urlValidee.toString());
          if (logoCandidate) {
            logoUrl = await telechargerEtHeberger(logoCandidate, draftId, 'logo-site').catch(() => null);
          }
          for (const src of photoCandidates.slice(0, 3)) {
            try {
              const hebergee = await telechargerEtHeberger(src, draftId, 'photo-site');
              photosUrls.push(hebergee);
            } catch {
              // une photo qui échoue ne doit pas bloquer les autres ni la génération des titres
            }
          }
        } catch {
          // récupération logo/photos best-effort : jamais bloquant pour la suite
        }
      }
    } else {
      prompt = construirePromptInspiration(structure, description, metiers, zone);
    }

    const resultat = await appellerClaude(prompt);

    return res.status(200).json({
      success: true,
      titres: resultat.titres,
      metierSuggere: resultat.metierSuggere,
      metierSuggereLabel: resultat.metierSuggereLabel,
      formulaireBrouillon: resultat.formulaireBrouillon,
      logoUrl,
      photosUrls,
    });
  } catch (err) {
    console.error('Erreur analyser-site-vitrine :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
