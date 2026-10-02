// /api/veille-appels-offres.js
// Veille gratuite des appels d'offres publics (02/10/2026) pour RMS EcoSky.
// Source : API officielle et gratuite du BOAMP (open data DILA, Opendatasoft).
//
// Fonctionnement : cron quotidien (vercel.json) qui récupère les avis de
// marchés de TRAVAUX publiés la veille dans les départements suivis, garde
// ceux qui contiennent un des mots-clés du métier, et envoie un email
// récapitulatif à Cyrille. Pas de stockage : on traite toujours "la veille
// complète", donc pas de doublon d'un jour à l'autre.
//
// Test sans envoi d'email (données publiques, pas de secret requis) :
//   https://www.skyeco.fr/api/veille-appels-offres?test=1&jours=7
//   -> renvoie en JSON les avis correspondants des 7 derniers jours.
//
// Réglages facultatifs (variables d'environnement Vercel) :
//   VEILLE_AO_DEPARTEMENTS  ex. "56,29,35"  (défaut : "56")
//   VEILLE_AO_MOTS_CLES     liste séparée par des virgules (défaut ci-dessous)
//   AGENT_RAPPORT_EMAIL     destinataire (défaut : c.bon@ecosky.fr)
// Variables déjà présentes : CRON_SECRET, RESEND_API_KEY.

const API_BOAMP = 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records';

const MOTS_CLES_DEFAUT = [
  'clôture', 'cloture', 'portail', 'enrobé', 'enrobe', 'voirie', 'vrd',
  'assainissement', 'résine', 'resine', 'revêtement de sol', 'revetement de sol',
  'sol souple', 'sol amortissant', 'aire de jeux', 'terrasse', "cour d'école", "cour de l'école",
  'parking', 'aménagement extérieur', 'amenagement exterieur', 'espaces extérieurs',
];

const sansAccent = s => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const echapper = s => (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const liste = v => (Array.isArray(v) ? v : v ? [v] : []);
const dateISO = d => d.toISOString().slice(0, 10);
const dateFR = s => (s ? new Date(s).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) : 'non précisée');

async function recupererAvis(departements, debut, fin) {
  const avis = [];
  for (const dep of departements) {
    let offset = 0;
    while (offset < 1000) {
      const params = new URLSearchParams({
        where: `dateparution >= date'${debut}' and dateparution <= date'${fin}'`,
        order_by: 'dateparution desc',
        limit: '100',
        offset: String(offset),
      });
      params.append('refine', `code_departement:${dep}`);
      params.append('refine', 'type_marche:TRAVAUX');
      const resp = await fetch(`${API_BOAMP}?${params}`);
      if (!resp.ok) throw new Error(`BOAMP ${resp.status} : ${(await resp.text()).slice(0, 300)}`);
      const data = await resp.json();
      const lot = data.results || [];
      avis.push(...lot);
      if (lot.length < 100) break;
      offset += 100;
    }
  }
  // Un même avis peut couvrir plusieurs départements : dédoublonnage par idweb.
  const vus = new Set();
  return avis.filter(a => (a.idweb && !vus.has(a.idweb) ? vus.add(a.idweb) : false));
}

function filtrer(avis, motsCles) {
  const mots = motsCles.map(sansAccent);
  return avis
    .map(a => {
      const texte = sansAccent([a.objet, ...liste(a.descripteur_libelle)].join(' '));
      const trouves = [...new Set(mots.filter(m => new RegExp('\\b' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(s|x)?\\b').test(texte)))];
      return { a, trouves };
    })
    .filter(x => x.trouves.length);
}

function versResume({ a, trouves }) {
  return {
    idweb: a.idweb,
    objet: a.objet,
    acheteur: a.nomacheteur,
    departements: liste(a.code_departement),
    publie_le: a.dateparution,
    date_limite: a.datelimitereponse,
    procedure: a.procedure_libelle || a.nature_libelle || null,
    mots_cles: trouves,
    lien: a.url_avis || `https://www.boamp.fr/pages/avis/?q=idweb:${a.idweb}`,
  };
}

function emailHtml(resumes, jourLabel) {
  const lignes = resumes.map(r => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #eee;">
      <strong>${echapper(r.objet)}</strong><br>
      <span style="color:#555;">${echapper(r.acheteur || '')} · dép. ${echapper(r.departements.join(', '))}</span><br>
      Date limite de réponse : <strong>${dateFR(r.date_limite)}</strong>${r.procedure ? ` · ${echapper(r.procedure)}` : ''}<br>
      <span style="color:#777;font-size:13px;">Mots-clés : ${echapper(r.mots_cles.join(', '))}</span><br>
      <a href="${echapper(r.lien)}">Voir l'avis sur le BOAMP</a>
    </td></tr>`).join('');
  return `<p>${resumes.length} appel(s) d'offres de travaux publié(s) ${jourLabel} correspond(ent) à tes métiers :</p>
    <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">${lignes}</table>
    <p style="color:#777;font-size:12px;">Source : BOAMP (open data). Les petits marchés des communes bretonnes sont aussi publiés sur Mégalis Bretagne, à suivre avec leurs propres alertes.</p>`;
}

export default async function handler(req, res) {
  const test = req.query?.test === '1';
  if (!test && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const departements = (process.env.VEILLE_AO_DEPARTEMENTS || '56').split(',').map(s => s.trim()).filter(Boolean);
  const motsCles = process.env.VEILLE_AO_MOTS_CLES
    ? process.env.VEILLE_AO_MOTS_CLES.split(',').map(s => s.trim()).filter(Boolean)
    : MOTS_CLES_DEFAUT;

  // Mode normal : la veille complète. Mode test : les N derniers jours.
  const jours = test ? Math.min(Math.max(parseInt(req.query.jours, 10) || 7, 1), 30) : 1;
  const hier = new Date(Date.now() - 24 * 3600 * 1000);
  const debut = dateISO(new Date(hier.getTime() - (jours - 1) * 24 * 3600 * 1000));
  const fin = dateISO(hier);

  try {
    const avis = await recupererAvis(departements, debut, fin);
    const resumes = filtrer(avis, motsCles).map(versResume);

    if (test) {
      return res.status(200).json({ periode: { debut, fin }, departements, avis_travaux: avis.length, correspondants: resumes.length, resultats: resumes });
    }

    if (resumes.length) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Veille marchés <notifications@ecoskybyrms.fr>',
          to: [process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr'],
          subject: `Appels d'offres : ${resumes.length} nouveau(x) marché(s) de travaux (${departements.join(', ')})`,
          html: emailHtml(resumes, `le ${dateFR(fin)}`),
        }),
      });
    }
    return res.status(200).json({ ok: true, periode: { debut, fin }, avis_travaux: avis.length, envoyes: resumes.length });
  } catch (e) {
    console.error('Erreur veille-appels-offres:', e);
    return res.status(500).json({ error: e.message });
  }
}
