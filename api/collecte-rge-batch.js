// api/collecte-rge-batch.js
//
// 28/09/2026 — Import des artisans RGE depuis l'open data officiel de l'ADEME
// (liste-des-entreprises-rge-2, licence Etalab, ~160 000 lignes, gratuit,
// email fourni directement par l'ADEME — pas de scraping).
//
// Chaque appel traite quelques pages (1000 lignes/page) puis s'arrête ; la
// position (curseur "next" de l'API) est stockée dans collecte_rge_progression,
// donc on rappelle l'endpoint jusqu'à toutTermine = true (page
// collecte-rge.html le fait en boucle automatiquement).
//
// Filtrage :
//   - qualification encore valide (lien_date_fin >= aujourd'hui)
//   - email présent et valide
//   - architectes, bureaux d'études et audits exclus (pas des artisans)
// Dédoublonnage (fonction SQL import_prospects_rge) : jamais de doublon de
// SIRET ni d'email avec la base existante — un contact désabonné (opt_out)
// n'est donc jamais réimporté.
//
// Requête : POST { motDePasseInterne, recommencer? }
// Variables : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INTERNAL_ACCESS_PASSWORD

const URL_DEPART = 'https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/lines?size=1000&select=siret,nom_entreprise,adresse,code_postal,commune,telephone,email,site_internet,domaine,meta_domaine,organisme,nom_qualification,lien_date_fin';
const PAGES_PAR_APPEL = 3;

function familleDepuisDomaine(domaine, metaDomaine) {
  const d = `${domaine || ''} ${metaDomaine || ''}`.toLowerCase();
  if (/photovolta|solaire|éolien|eolien|géotherm|geotherm/.test(d)) return 'Énergies renouvelables (RGE)';
  if (/fen[êe]tre|menuiser|volet|porte/.test(d)) return 'Menuiserie (RGE)';
  if (/pompe|chaudi|chauff|po[êe]le|insert|bois|ventilation|vmc|eau chaude|thermodyn|climati|réseau|reseau/.test(d)) return 'Chauffage / ventilation (RGE)';
  if (/isolation|isolant|combles|toiture|murs|plancher|ite\b/.test(d)) return 'Isolation / enveloppe (RGE)';
  return 'Rénovation (RGE)';
}

function estArtisan(l) {
  const t = `${l.domaine || ''} ${l.nom_qualification || ''} ${l.organisme || ''}`.toLowerCase();
  return !/architecte|cnoa|audit|[ée]tude|bureau d|diagnostic|ma[îi]trise d'?\s?[œo]euvre/.test(t);
}

function departementDepuisCP(cp) {
  const c = String(cp || '').trim();
  if (!/^\d{5}$/.test(c)) return null;
  if (c.startsWith('97')) return c.slice(0, 3);
  if (c.startsWith('20')) return Number(c) < 20200 ? '2A' : '2B';
  return c.slice(0, 2);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  const { motDePasseInterne, recommencer } = req.body || {};
  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }

  const supa = process.env.SUPABASE_URL;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    if (recommencer) {
      await fetch(`${supa}/rest/v1/collecte_rge_progression?id=eq.1`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ next_url: null, lignes_lues: 0, inseres: 0, termine: false, maj: new Date().toISOString() }),
      });
    }

    const progResp = await fetch(`${supa}/rest/v1/collecte_rge_progression?id=eq.1&select=*`, { headers });
    const prog = (progResp.ok ? await progResp.json() : [])[0] || { next_url: null, lignes_lues: 0, inseres: 0, termine: false };
    if (prog.termine) {
      return res.status(200).json({ success: true, toutTermine: true, lignesLues: prog.lignes_lues, inseresTotal: prog.inseres });
    }

    const aujourdhui = new Date().toISOString().slice(0, 10);
    let url = prog.next_url || URL_DEPART;
    let lignesLues = 0, retenues = 0, inseres = 0, termine = false, total = null;

    for (let p = 0; p < PAGES_PAR_APPEL; p++) {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`ADEME a répondu ${r.status} : ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      total = data.total;
      const lignes = data.results || [];
      lignesLues += lignes.length;

      const aImporter = lignes
        .filter((l) => (!l.lien_date_fin || l.lien_date_fin >= aujourdhui) && estArtisan(l))
        .map((l) => ({ ...l, email: String(l.email || '').trim().toLowerCase() }))
        .filter((l) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(l.email) && l.siret)
        .map((l) => ({
          siret: String(l.siret),
          email: l.email,
          nom_entreprise: l.nom_entreprise || '',
          ville: l.commune || '',
          adresse: [l.adresse, l.code_postal].filter(Boolean).join(' ') || null,
          departement: departementDepuisCP(l.code_postal),
          telephone: l.telephone || null,
          site_web: l.site_internet || '',
          metier: l.domaine || 'Artisan RGE',
          famille_metier: familleDepuisDomaine(l.domaine, l.meta_domaine),
        }));
      retenues += aImporter.length;

      if (aImporter.length) {
        const ins = await fetch(`${supa}/rest/v1/rpc/import_prospects_rge`, {
          method: 'POST', headers, body: JSON.stringify({ lignes: aImporter }),
        });
        if (!ins.ok) throw new Error('Insertion Supabase impossible : ' + (await ins.text()).slice(0, 300));
        inseres += Number(await ins.json()) || 0;
      }

      if (!data.next || !lignes.length) { termine = true; url = null; break; }
      url = data.next;
    }

    const lignesTotal = (prog.lignes_lues || 0) + lignesLues;
    const inseresTotal = (prog.inseres || 0) + inseres;
    await fetch(`${supa}/rest/v1/collecte_rge_progression?id=eq.1`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ next_url: url, lignes_lues: lignesTotal, inseres: inseresTotal, termine, maj: new Date().toISOString() }),
    });

    return res.status(200).json({
      success: true, toutTermine: termine, lignesLuesCeLot: lignesLues, retenuesCeLot: retenues,
      nouveauxCeLot: inseres, lignesLues: lignesTotal, inseresTotal, totalADEME: total,
    });
  } catch (err) {
    console.error('collecte-rge-batch :', err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
}
