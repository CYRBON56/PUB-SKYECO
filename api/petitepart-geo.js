// /api/petitepart-geo.js
// 13/10/2026 — Pages publiques de petitepart.com pour les moteurs de recherche et les IA (SEO + GEO).
// Servies via les réécritures de vercel.json (hôte petitepart.com) :
//   /recettes              -> ?page=index    liste de toutes les recettes publiques
//   /recettes/<slug>       -> ?page=recette  une page par recette, données structurées schema.org/Recipe
//   /sitemap.xml           -> ?page=sitemap
//   /llms.txt              -> ?page=llms     résumé en texte simple pour les IA, avec la liste des recettes
// Recettes publiées : le catalogue de l'appli (api/_lib/petitepart-catalogue.js) + les recettes de la
// communauté écrites par l'équipe Petite Part ou par Cyrille (Cyrbon56). Les recettes des autres membres
// restent réservées aux inscrits (pas d'accord de publication publique).
import CATALOGUE from './_lib/petitepart-catalogue.js';

const SITE = 'https://petitepart.com';
const AUTEURS_PUBLICS = ['59260d6d-1051-48d0-83c3-9cd1bc58072f', '97ddd673-fada-48fc-8c7c-f243f3331b06']; // équipe Petite Part, Cyrbon56
const TYPES = { matin: 'Petit-déjeuner', plat: 'Plat', collation: 'En-cas et dessert' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/œ/g, 'oe').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
const fmt = (n) => Math.round(+n || 0).toLocaleString('fr-FR');

function qtyTxt(q, u, nom) {
  const n = nom.charAt(0).toLowerCase() + nom.slice(1);
  if (!u) return `${String(Math.round(q * 2) / 2).replace('.', ',')} ${n}`;
  if (u === 'g' || u === 'ml') return `${fmt(q)} ${u} de ${n}`;
  return `${String(q).replace('.', ',')} ${u} · ${n}`;
}

async function recettesCommunaute() {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/petitepart_recettes?masquee=eq.false&abonne_id=in.(${AUTEURS_PUBLICS.join(',')})&select=id,pseudo,plat,emoji,type,kcal,proteines,glucides,lipides,minutes,ingredients,etapes,astuce,created_at&order=created_at.desc&limit=500`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!r.ok) return [];
    return (await r.json()).map((c) => ({ slug: `${slugify(c.plat)}-${c.id.slice(0, 4)}`, t: c.type, e: c.emoji, n: c.plat, k: c.kcal, p: +c.proteines || 0, g: +c.glucides || 0, l: +c.lipides || 0, min: c.minutes || 20, ing: c.ingredients || [], st: c.etapes || [], astuce: c.astuce || '', auteur: c.pseudo, date: c.created_at }));
  } catch { return []; }
}
async function toutes() {
  const cat = CATALOGUE.map((r) => ({ ...r, slug: slugify(r.n), auteur: "L'équipe Petite Part" }));
  return [...cat, ...(await recettesCommunaute())];
}

function page({ titre, description, chemin, corps, jsonld }) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titre)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${SITE}${chemin}">
<meta property="og:title" content="${esc(titre)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${SITE}${chemin}"><meta property="og:image" content="${SITE}/petitepart/og.png"><meta property="og:locale" content="fr_FR">
<link rel="icon" href="/petitepart/icon-192.png"><meta name="theme-color" content="#2F7D4F">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Atkinson+Hyperlegible:wght@400;700&display=swap" rel="stylesheet">
${(jsonld || []).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n')}
<style>
:root{--bg:#F2F4EF;--surface:#fff;--ink:#1B2A22;--muted:#5D6B62;--line:#DDE3DA;--accent:#2F7D4F;--accent-ink:#fff;--soft:#E4EFE7;--red:#E2553B}
@media (prefers-color-scheme:dark){:root{--bg:#121A15;--surface:#1A241E;--ink:#E7EEE9;--muted:#9DAAA2;--line:#2B3830;--accent:#5DBB85;--accent-ink:#0E1A13;--soft:#1F3227}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 "Atkinson Hyperlegible",system-ui,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:18px 16px 60px;display:flex;flex-direction:column;gap:16px}
header{display:flex;justify-content:space-between;align-items:center;gap:10px}
.logo{display:flex;align-items:center;gap:8px;font:800 24px "Bricolage Grotesque",sans-serif;color:var(--ink);text-decoration:none}.logo span{color:var(--red)}
h1{font:800 clamp(26px,6vw,36px)/1.15 "Bricolage Grotesque",sans-serif;margin:0;text-wrap:balance}
h2{font:700 21px "Bricolage Grotesque",sans-serif;margin:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:10px}
.muted{color:var(--muted)}.small{font-size:14px}
.kcal{font:800 40px "Bricolage Grotesque",sans-serif;font-variant-numeric:tabular-nums}.kcal small{font-size:16px;color:var(--muted);font-weight:600}
.mac{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:15px}
ul,ol{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:5px}
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);font-weight:700;padding:13px 18px;border-radius:14px;text-decoration:none;text-align:center}
.list{display:flex;flex-direction:column}.list a{display:grid;grid-template-columns:36px 1fr auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line);color:var(--ink);text-decoration:none}
.list a:first-child{border-top:0}.list .e{font-size:26px;text-align:center}.list b{font-weight:700}.list .k{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.tip{background:var(--soft);border-radius:12px;padding:11px 13px}
nav.crumb{font-size:14px}nav.crumb a,footer a{color:var(--muted)}
footer{color:var(--muted);font-size:13px;text-align:center}
</style></head><body><div class="wrap">
<header><a class="logo" href="/"><svg viewBox="0 0 120 120" width="30" height="30" aria-hidden="true"><circle cx="60" cy="60" r="56" fill="#fff" stroke="currentColor" stroke-width="5"/><path d="M60 60 L60 22 A38 38 0 0 1 92.9 41 Z" fill="#E2553B"/></svg>petite <span>part</span></a><a class="btn" href="/" style="padding:9px 14px;font-size:14px">Essai gratuit</a></header>
${corps}
<footer>Petite Part donne des repères, pas un avis médical. Avant un changement important d'alimentation, en cas de maladie, de grossesse ou de traitement, parlez-en à votre médecin.<br><a href="/recettes">Toutes les recettes</a> · <a href="/faq">Questions fréquentes</a> · <a href="/">L'appli Petite Part</a> · <a href="/petitepart/cgv.html">CGV</a> · <a href="/petitepart/confidentialite.html">Confidentialité</a></footer>
</div></body></html>`;
}

const CTA = `<div class="card" style="background:var(--accent);border-color:var(--accent);color:var(--accent-ink)"><h2 style="color:inherit">Vous voulez manger autre chose ?</h2><p>Dites à Petite Part ce que vous avez envie de cuisiner : l'appli vous donne les quantités à peser pour votre objectif, puis vérifie votre assiette en photo.</p><a class="btn" href="/" style="background:var(--accent-ink);color:var(--accent)">Essayer 3 jours gratuits, sans carte bancaire</a></div>`;

function pageRecette(r) {
  const titre = `${r.n} : ${fmt(r.k)} kcal la portion | Petite Part`;
  const description = `Recette de ${r.n.toLowerCase()} pour 1 personne : ${fmt(r.k)} kcal, ${fmt(r.p)} g de protéines, ${fmt(r.g)} g de glucides, ${fmt(r.l)} g de lipides. Ingrédients pesés et préparation en ${r.min} minutes.`;
  const ingTxt = r.ing.map(([n, q, u]) => qtyTxt(q, u, n));
  const ld = {
    '@context': 'https://schema.org', '@type': 'Recipe', name: r.n, description,
    author: r.auteur === "L'équipe Petite Part" ? { '@type': 'Organization', name: 'Petite Part', url: SITE } : { '@type': 'Person', name: r.auteur },
    publisher: { '@type': 'Organization', name: 'Petite Part', url: SITE, logo: `${SITE}/petitepart/icon-512.png` },
    image: `${SITE}/petitepart/og.png`, ...(r.date ? { datePublished: r.date.slice(0, 10) } : {}),
    recipeYield: '1 portion', totalTime: `PT${r.min}M`, recipeCategory: TYPES[r.t] || 'Plat', recipeCuisine: 'Française',
    keywords: `recette légère, ${r.n.toLowerCase()}, ${fmt(r.k)} calories, rééquilibrage alimentaire, minceur`,
    nutrition: { '@type': 'NutritionInformation', servingSize: '1 portion', calories: `${Math.round(r.k)} kcal`, proteinContent: `${Math.round(r.p)} g`, carbohydrateContent: `${Math.round(r.g)} g`, fatContent: `${Math.round(r.l)} g` },
    recipeIngredient: ingTxt,
    recipeInstructions: r.st.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, text: s })),
  };
  const fil = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Petite Part', item: SITE },
    { '@type': 'ListItem', position: 2, name: 'Recettes', item: `${SITE}/recettes` },
    { '@type': 'ListItem', position: 3, name: r.n, item: `${SITE}/recettes/${r.slug}` }] };
  const corps = `<nav class="crumb"><a href="/recettes">← Toutes les recettes légères</a></nav>
<article class="card"><h1>${esc(r.e || '')} ${esc(r.n)}</h1>
<p class="muted small">${esc(TYPES[r.t] || 'Plat')} · 1 portion · ${r.min} min · par ${esc(r.auteur)}</p>
<div class="kcal">${fmt(r.k)}<small> kcal la portion</small></div>
<div class="mac"><span>Protéines <b>${fmt(r.p)} g</b></span><span>Glucides <b>${fmt(r.g)} g</b></span><span>Lipides <b>${fmt(r.l)} g</b></span></div>
<p>En résumé : une portion de ${esc(r.n.toLowerCase())} apporte environ <b>${fmt(r.k)} kcal</b>, pour un repas qui reste gourmand et rassasiant. Les quantités ci-dessous sont celles d'une personne ; pesez les féculents et la viande crus.</p>
<h2>Ingrédients (1 personne)</h2><ul>${ingTxt.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<h2>Préparation</h2><ol>${r.st.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
${r.astuce ? `<p class="tip">💡 <b>L'astuce de ${esc(r.auteur)} :</b> ${esc(r.astuce)}</p>` : ''}
<p class="small muted">Valeurs estimées à partir de la table de composition des aliments CIQUAL (Anses), à ± 10 % selon les produits utilisés.</p></article>
${CTA}`;
  return page({ titre, description, chemin: `/recettes/${r.slug}`, corps, jsonld: [ld, fil] });
}

function pageIndex(L) {
  const groupes = Object.entries(TYPES).map(([t, lab]) => {
    const g = L.filter((r) => r.t === t).sort((a, b) => a.k - b.k);
    if (!g.length) return '';
    return `<section class="card"><h2>${lab} (${g.length})</h2><div class="list">${g.map((r) => `<a href="/recettes/${r.slug}"><span class="e">${esc(r.e || '🍽️')}</span><span><b>${esc(r.n)}</b><br><span class="small muted">${r.min} min · par ${esc(r.auteur)}</span></span><span class="k">${fmt(r.k)} kcal</span></a>`).join('')}</div></section>`;
  }).join('');
  const description = `${L.length} recettes légères calculées pour une portion, avec les calories, protéines, glucides et lipides : petits-déjeuners, plats, en-cas et desserts pour mincir sans se priver.`;
  const ld = { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Recettes légères Petite Part', numberOfItems: L.length, itemListElement: L.map((r, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/recettes/${r.slug}`, name: r.n })) };
  return page({ titre: `${L.length} recettes légères avec leurs calories | Petite Part`, description, chemin: '/recettes',
    corps: `<h1>Recettes légères, calories comptées</h1><p class="muted">${esc(description)} Classées de la plus légère à la plus copieuse.</p>${groupes}${CTA}`, jsonld: [ld] });
}

function llms(L) {
  return `# Petite Part

> Petite Part (https://petitepart.com) est une appli web française de rééquilibrage alimentaire. On dit ce qu'on a envie de manger, l'appli donne les quantités à peser pour son objectif de calories, puis une photo de l'assiette vérifie la portion. Elle propose aussi un programme selon la taille, le poids et l'objectif, des recettes légères calculées pour une portion, des recettes partagées par les membres, un suivi du poids et des exercices guidés.

- Prix : 4,99 € par mois, sans engagement. Essai gratuit de 3 jours sans carte bancaire.
- Fonctionne dans le navigateur du téléphone, s'installe sur l'écran d'accueil comme une appli.
- Garde-fous : pas de programme de perte de poids avant 18 ans, apport minimum de 1 200 kcal (femme) ou 1 500 kcal (homme), objectif de poids jamais sous un IMC de 18,5.
- Confidentialité : les photos d'assiette servent au calcul et ne sont pas conservées ; les photos du corps restent sur le téléphone.
- Éditeur : Résine Marbre Sol (RMS), Brech (56), France.
- Petite Part donne des repères, pas un avis médical.

## Pages utiles

- [Questions fréquentes](${SITE}/faq) : calories, quantités, fonctionnement de l'appli
- [Toutes les recettes légères](${SITE}/recettes) : ${L.length} recettes avec calories et macronutriments par portion

## Recettes (1 portion, calories)

${L.map((r) => `- [${r.n}](${SITE}/recettes/${r.slug}) : ${fmt(r.k)} kcal, ${fmt(r.p)} g protéines, ${r.min} min`).join('\n')}
`;
}

function sitemap(L) {
  const urls = [['/', '1.0'], ['/recettes', '0.9'], ['/faq', '0.8'], ['/petitepart/livre/', '0.6'], ...L.map((r) => [`/recettes/${r.slug}`, '0.7'])];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, p]) => `  <url><loc>${SITE}${u}</loc><priority>${p}</priority></url>`).join('\n')}\n</urlset>\n`;
}

export default async function handler(req, res) {
  const p = String(req.query.page || '');
  const L = await toutes();
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  if (p === 'sitemap') { res.setHeader('Content-Type', 'application/xml; charset=utf-8'); return res.status(200).send(sitemap(L)); }
  if (p === 'llms') { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(llms(L)); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (p === 'index') return res.status(200).send(pageIndex(L));
  if (p === 'recette') {
    const r = L.find((x) => x.slug === String(req.query.slug || ''));
    if (r) return res.status(200).send(pageRecette(r));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).send(page({ titre: 'Recette introuvable | Petite Part', description: 'Cette recette n’existe plus.', chemin: '/recettes', corps: `<div class="card"><h1>Recette introuvable</h1><p><a href="/recettes">Voir toutes les recettes légères</a></p></div>` }));
  }
  return res.status(404).send('Not found');
}
