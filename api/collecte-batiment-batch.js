// api/collecte-batiment-batch.js
//
// Collecte nationale (métropole + DROM) des professionnels du bâtiment :
// SIRENE (recherche-entreprises.api.gouv.fr, gratuit) pour la liste des
// entreprises par code APE x département, puis recherche d'email par
// entreprise (DuckDuckGo + scraping du site trouvé).
//
// Conçu comme prospection-send-batch.js : chaque appel ne traite qu'UN
// PETIT LOT (une page SIRENE = jusqu'à 25 entreprises pour un seul
// croisement métier/département), jamais toute la collecte d'un coup —
// impossible en une seule requête serveur vu le volume national. La
// progression est stockée dans collecte_batiment_progression, donc on
// peut rappeler cet endpoint autant de fois que nécessaire (bouton
// "Lancer un lot" côté page, ou cron), il reprend toujours où il s'est
// arrêté.
//
// Requête : POST { motDePasseInterne }
// Réponse : { success, combo: {codeApe, departement}, entreprises,
//             nouvellesEnBase, emailsTrouves, toutTermine }

const METIERS = {
  '4399D': 'Autres travaux spécialisés (résine, étanchéité...)',
  '4321A': "Travaux d'installation électrique",
  '4322A': "Travaux d'installation eau et gaz",
  '4322B': 'Installations thermiques / climatisation',
  '4391A': 'Travaux de charpente',
  '4391B': 'Travaux de couverture',
  '4120A': 'Construction de maisons individuelles',
  '4120B': "Construction d'autres bâtiments",
  '4399C': 'Maçonnerie générale / gros œuvre',
  '4333Z': 'Revêtement des sols et des murs',
  '4334Z': 'Peinture et vitrerie',
  '4332A': 'Menuiserie bois et PVC',
  '4332B': 'Menuiserie métallique / serrurerie',
  '4339Z': 'Autres travaux de finition',
  '4312A': 'Terrassement courants',
};

// Métropole (01-19, 2A/2B, 21-95) + DROM (971-974, 976). Les COM
// (Polynésie, Nouvelle-Calédonie, Wallis-et-Futuna...) ne sont pas dans
// SIRENE — pas inclus.
function listeDepartements() {
  const deps = [];
  for (let n = 1; n <= 95; n++) {
    if (n === 20) { deps.push('2A', '2B'); continue; }
    deps.push(String(n).padStart(2, '0'));
  }
  deps.push('971', '972', '973', '974', '976');
  return deps;
}
const DEPARTEMENTS = listeDepartements();

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function prochainCombo(supaHeaders) {
  // Cherche un croisement déjà en cours (non terminé) ; sinon en crée un
  // nouveau parmi ceux jamais tentés.
  const enCoursResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/collecte_batiment_progression?termine=eq.false&select=*&order=derniere_activite.asc&limit=1`,
    { headers: supaHeaders }
  );
  const enCours = enCoursResp.ok ? await enCoursResp.json() : [];
  if (enCours.length) return enCours[0];

  const dejaTentesResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/collecte_batiment_progression?select=code_ape,departement`,
    { headers: supaHeaders }
  );
  const dejaTentes = new Set((dejaTentesResp.ok ? await dejaTentesResp.json() : []).map((r) => r.code_ape + '|' + r.departement));

  for (const codeApe of Object.keys(METIERS)) {
    for (const dep of DEPARTEMENTS) {
      if (!dejaTentes.has(codeApe + '|' + dep)) return { code_ape: codeApe, departement: dep, page_courante: 1, id: null };
    }
  }
  return null; // tout a été tenté
}

function extraireEmails(html) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const trouves = (html.match(regex) || [])
    .map((e) => e.toLowerCase())
    .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(e))
    .filter((e) => !e.includes('wixpress') && !e.includes('sentry') && !e.includes('example.'));
  return [...new Set(trouves)];
}

async function chercherSiteWeb(raisonSociale, ville) {
  const requete = encodeURIComponent(`${raisonSociale} ${ville}`);
  const resp = await fetch(`https://html.duckduckgo.com/html/?q=${requete}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RechercheProBTP/1.0)' },
  });
  if (!resp.ok) return null;
  const html = await resp.text();
  const matches = [...html.matchAll(/uddg=([^&"]+)/g)].map((m) => decodeURIComponent(m[1]));
  const exclus = /facebook\.|linkedin\.|pagesjaunes\.|societe\.com|pappers\.fr|instagram\.|google\./i;
  return matches.find((u) => !exclus.test(u)) || null;
}

async function trouverEmailEntreprise(raisonSociale, ville) {
  try {
    const site = await chercherSiteWeb(raisonSociale, ville);
    if (!site) return { site: null, email: null, statut: 'site_non_trouve' };
    const pages = [site, site.replace(/\/?$/, '/contact'), site.replace(/\/?$/, '/mentions-legales')];
    for (const pageUrl of pages) {
      try {
        const resp = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!resp.ok) continue;
        const emails = extraireEmails(await resp.text());
        if (emails.length) return { site, email: emails[0], statut: 'trouve' };
      } catch { /* page suivante */ }
    }
    return { site, email: null, statut: 'site_trouve_sans_email' };
  } catch (err) {
    return { site: null, email: null, statut: 'erreur: ' + String(err.message || err).slice(0, 100) };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  const { motDePasseInterne } = req.body || {};
  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const combo = await prochainCombo(supaHeaders);
    if (!combo) {
      return res.status(200).json({ success: true, toutTermine: true, message: 'Tous les croisements métier x département ont été traités.' });
    }

    const { code_ape: codeApe, departement } = combo;

    // L'API attend le code APE au format "43.21A" (avec le point), pas
    // "4321A" — sans ça elle renvoie systématiquement 0 résultat, ce qui
    // explique le "0 nouvelles entreprises" partout observé le 16/09.
    const codeApeAvecPoint = codeApe.replace(/^(\d{2})(\d{2})([A-Z])$/, '$1.$2$3');

    const url = `https://recherche-entreprises.api.gouv.fr/search?activite_principale=${codeApeAvecPoint}&departement=${departement}&page=${combo.page_courante}&per_page=25&minimal=true`;
    const sireneResp = await fetch(url, { headers: { Accept: 'application/json' } });
    let sireneErreur = null;
    let sireneData = { results: [] };
    if (sireneResp.ok) {
      sireneData = await sireneResp.json();
    } else {
      sireneErreur = `SIRENE a répondu ${sireneResp.status} : ${(await sireneResp.text()).slice(0, 200)}`;
      console.error('collecte-batiment-batch, appel SIRENE échoué:', sireneErreur);
    }
    const lot = sireneData.results || [];

    let nouvellesEnBase = 0;
    let emailsTrouves = 0;

    for (const e of lot) {
      const siege = e.siege || {};
      const siret = siege.siret || e.siren;
      if (!siret) continue;
      const raisonSociale = e.nom_complet || e.nom_raison_sociale || '';
      const ville = siege.libelle_commune || '';

      // Déjà en base (par SIRET) ? On ne refait pas la recherche d'email.
      const dejaResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?siret=eq.${encodeURIComponent(siret)}&select=id`,
        { headers: supaHeaders }
      );
      const deja = dejaResp.ok ? await dejaResp.json() : [];
      if (deja.length) continue;

      const { site, email, statut } = await trouverEmailEntreprise(raisonSociale, ville);
      if (email) emailsTrouves++;

      await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste`, {
        method: 'POST',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          siret,
          nom_entreprise: raisonSociale,
          ville,
          adresse: siege.adresse || null,
          code_postal: siege.code_postal || null,
          departement,
          code_ape: codeApe,
          metier: METIERS[codeApe],
          site_web: site,
          email: email || null,
          statut_email_collecte: statut,
          source_collecte: 'sirene',
          email_envoye: false,
          opt_out: false,
          bounced: false,
          stopped: false,
        }),
      });
      nouvellesEnBase++;
      await dormir(1500); // reste raisonnable vis-à-vis de DuckDuckGo
    }

    const termine = lot.length < 25; // dernière page de ce croisement

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/collecte_batiment_progression`, {
      method: 'POST',
      headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        code_ape: codeApe,
        departement,
        page_courante: termine ? combo.page_courante : combo.page_courante + 1,
        termine,
        entreprises_trouvees: nouvellesEnBase,
        emails_trouves: emailsTrouves,
        derniere_activite: new Date().toISOString(),
      }),
    });

    return res.status(200).json({
      success: true,
      toutTermine: false,
      combo: { codeApe, metier: METIERS[codeApe], departement },
      page: combo.page_courante,
      entreprisesDansLot: lot.length,
      nouvellesEnBase,
      emailsTrouves,
      comboTermine: termine,
      sireneErreur, // null si tout s'est bien passé — sinon, la vraie cause à regarder
    });
  } catch (err) {
    console.error('collecte-batiment-batch error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Erreur pendant la collecte.' });
  }
}
