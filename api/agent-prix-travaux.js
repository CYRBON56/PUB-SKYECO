// /api/agent-prix-travaux.js
// Agent d'audit de la campagne Google Ads « Skyeco - Prix travaux particuliers - France »
// (campagne 24304238293, compte 784-990-3984). Lancé tous les 2 jours à 8 h (heure de Paris)
// par Vercel Cron, ou à la main avec ?force=1 + le même en-tête d'autorisation.
//
// Ce qu'il fait à chaque passage :
//   1. Lit les chiffres Google Ads (via Windsor.ai) : dépenses, clics, impressions par métier,
//      et les recherches réelles qui ont déclenché les annonces.
//   2. Lit les ventes réelles de l'estimateur dans Supabase (prix_travaux_commandes).
//   3. Demande à Claude un audit : coût par vente par métier, recherches inutiles, conseils.
//   4. Garde-fou : la SEULE action automatique autorisée est l'ajout de mots-clés négatifs
//      (au plus 10 par passage, jamais un terme qui bloquerait nos propres mots-clés).
//      Budget, pause d'un métier ou nouveaux mots-clés = recommandations écrites uniquement.
//   5. Envoie le rapport par email à Cyrille (+ un SMS court si Twilio est configuré)
//      et l'archive dans la table agent_prix_travaux_audits.
//
// Variables : CRON_SECRET, WINDSOR_API_KEY, ANTHROPIC_API_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY ; facultatives : AGENT_RAPPORT_EMAIL,
// ADMIN_PHONE, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.

const COMPTE = '784-990-3984';
const CAMPAGNE_ID = '24304238293';
const LANCEMENT = '2026-09-28';
const PRIX_HT = 29.92;
const WINDSOR = 'https://connectors.windsor.ai/google_ads';
const GROUPES = {
  '200910235655': { metier: 'toiture', nom: 'Toiture' },
  '209057891228': { metier: 'pac', nom: 'Pompe à chaleur' },
  '204219133121': { metier: 'isolation', nom: 'Isolation' },
  '200910239975': { metier: 'menuiseries', nom: 'Menuiseries' },
  '204351643327': { metier: 'ravalement', nom: 'Façade' },
  '199322283783': { metier: 'sdb', nom: 'Salle de bain' },
};
const MOTS_CLES_POSITIFS = [
  'prix refection toiture', 'prix renovation toiture', 'cout refection toiture', 'prix toiture au m2', 'prix couverture tuile m2',
  'devis toiture trop cher', 'comparer devis toiture', 'prix demoussage toiture m2', 'devis couvreur prix',
  'prix pompe a chaleur air eau posee', 'prix installation pompe a chaleur', 'cout installation pompe a chaleur', 'prix pac air eau installation',
  'devis pompe a chaleur trop cher', 'comparer devis pompe a chaleur', 'prix pompe a chaleur air air posee', 'prix climatisation reversible posee',
  'prix chauffe eau thermodynamique pose', 'prix isolation exterieure m2', 'cout isolation murs exterieurs', 'devis isolation exterieure prix',
  'prix isolation combles m2', 'prix isolation rampants m2', 'prix isolation murs interieur m2', 'comparer devis isolation', 'devis isolation trop cher',
  'prix fenetre pvc posee', 'prix pose fenetre', 'cout remplacement fenetres', 'prix remplacement fenetres maison', 'prix porte d entree posee',
  'prix baie vitree posee', 'devis fenetres trop cher', 'comparer devis fenetres', 'prix fenetre alu posee', 'prix ravalement facade m2',
  'cout ravalement facade', 'devis ravalement facade prix', 'prix ravalement facade maison', 'prix peinture facade m2', 'prix enduit facade m2',
  'comparer devis ravalement', 'prix renovation salle de bain', 'cout renovation salle de bain complete', 'prix renovation salle de bain m2',
  'devis salle de bain prix', 'prix douche italienne posee', 'prix remplacement baignoire par douche', 'comparer devis salle de bain',
];
const MOTS_INTOUCHABLES = new Set(['prix', 'devis', 'cout', 'coût', 'comparer', 'toiture', 'pompe', 'chaleur', 'isolation', 'fenetre', 'fenêtre', 'fenetres', 'fenêtres', 'facade', 'façade', 'salle', 'bain', 'ravalement', 'pac', 'm2']);

const jour = (d) => d.toISOString().slice(0, 10);
const normal = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const eur = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €';

async function windsor(fields, du, au) {
  try {
    const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', CAMPAGNE_ID]]));
    const url = `${WINDSOR}?api_key=${process.env.WINDSOR_API_KEY}&accounts=${encodeURIComponent(COMPTE)}&fields=${fields.join(',')}&filter=${filtre}&date_from=${du}&date_to=${au}`;
    const r = await fetch(url); const j = await r.json();
    return r.ok && Array.isArray(j.data) ? j.data : [];
  } catch { return []; }
}

async function sb(path, opts = {}) {
  const K = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Supabase ${path} : ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

function parGroupe(lignes) {
  const out = {};
  for (const id of Object.keys(GROUPES)) out[id] = { clics: 0, impressions: 0, cout: 0 };
  for (const l of lignes) {
    const g = out[String(l.ad_group_id)]; if (!g) continue;
    g.clics += +l.clicks || 0; g.impressions += +l.impressions || 0; g.cout += +l.cost || 0;
  }
  return out;
}

// Garde-fou : un négatif ne doit jamais bloquer un de nos mots-clés positifs.
function negatifAutorise(terme) {
  const n = normal(terme);
  if (!n || n.length < 3 || n.split(' ').length > 4) return false;
  if (n.split(' ').every((m) => MOTS_INTOUCHABLES.has(m))) return false;
  return !MOTS_CLES_POSITIFS.some((k) => (' ' + normal(k) + ' ').includes(' ' + n + ' '));
}

async function ajouterNegatifs(termes) {
  const r = await fetch(`${WINDSOR}/actions?api_key=${process.env.WINDSOR_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: COMPTE, action: 'push_negative_keywords', params: { level: 'campaign', campaign_id: CAMPAGNE_ID, keywords: termes.map((text) => ({ text, match_type: 'PHRASE' })) } }),
  });
  if (!r.ok) throw new Error('Windsor : ' + (await r.text()));
}

async function auditIA(donnees) {
  const outils = [{
    name: 'exclure_recherches',
    description: "Ajoute des mots-clés négatifs (correspondance de l'expression) au niveau de la campagne, pour bloquer des recherches qui ne mènent pas à un achat (recherches informatives, bricolage, emploi, marques, autres services). Au plus 10 termes, de 1 à 4 mots chacun.",
    input_schema: { type: 'object', properties: { termes: { type: 'array', items: { type: 'string' }, maxItems: 10 }, raison: { type: 'string' } }, required: ['termes', 'raison'] },
  }];
  const systeme = `Tu es l'agent d'audit de la campagne Google Ads de Skyeco, qui vend en ligne une estimation détaillée de travaux à des particuliers (35,90 € TTC, soit ${PRIX_HT} € HT). Une vente n'est rentable que si le coût publicitaire par vente reste sous ${PRIX_HT} €.
Tu reçois les chiffres des 2 derniers jours et depuis le lancement, par métier, les recherches réelles des internautes et les ventes réelles.
1. Si des recherches montrent clairement une intention non commerciale (information, bricolage, emploi, formation, aides, marque d'enseigne, autre prestation), utilise l'outil exclure_recherches, une seule fois, pour les bloquer. N'exclus jamais une recherche qui a mené à une vente, ni un terme qui décrit nos métiers.
2. Rédige ensuite l'audit pour Cyrille, en français simple, sans jargon, en 12 lignes maximum : ce qui marche, ce qui coûte sans vendre, et au plus 3 recommandations concrètes (budget, métier à couper ou renforcer, nouvelle idée de mot-clé). Tu ne peux pas appliquer ces recommandations toi-même : Cyrille décide.
S'il n'y a pas encore assez de données (moins de 50 clics au total), dis-le simplement et ne tire pas de conclusion.`;
  const messages = [{ role: 'user', content: JSON.stringify(donnees) }];
  const appliquees = [];
  for (let tour = 0; tour < 3; tour++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, system: systeme, tools: outils, messages }),
    });
    const j = await r.json(); if (!r.ok) throw new Error('Claude : ' + JSON.stringify(j));
    messages.push({ role: 'assistant', content: j.content });
    const appels = j.content.filter((c) => c.type === 'tool_use');
    if (!appels.length) return { synthese: j.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(), appliquees };
    const resultats = [];
    for (const a of appels) {
      let msg;
      if (appliquees.length) msg = 'Refusé : une seule exclusion par audit.';
      else {
        const ok = [...new Set((a.input.termes || []).map((t) => normal(t)))].filter(negatifAutorise).slice(0, 10);
        const refuses = (a.input.termes || []).filter((t) => !ok.includes(normal(t)));
        if (ok.length) { await ajouterNegatifs(ok); appliquees.push({ action: 'mots_cles_negatifs', termes: ok, raison: a.input.raison }); }
        msg = `Ajoutés : ${ok.join(', ') || 'aucun'}. Refusés par le garde-fou : ${refuses.join(', ') || 'aucun'}.`;
      }
      resultats.push({ type: 'tool_result', tool_use_id: a.id, content: msg });
    }
    messages.push({ role: 'user', content: resultats });
  }
  return { synthese: 'Audit interrompu (trop d\'échanges avec l\'IA).', appliquees };
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const maintenant = new Date(), hier = new Date(maintenant - 86400000), avantHier = new Date(maintenant - 2 * 86400000);
    const du = jour(avantHier), au = jour(hier), aujourdhui = jour(maintenant);
    const champs = ['ad_group_id', 'clicks', 'impressions', 'cost'];
    const [periodeL, cumulL, termesL] = await Promise.all([
      windsor(champs, du, au), windsor(champs, LANCEMENT, aujourdhui),
      windsor(['ad_group_id', 'search_term_view_search_term', 'clicks', 'cost'], du, au),
    ]);
    const periode = parGroupe(periodeL), cumul = parGroupe(cumulL);
    const ventes = await sb(`prix_travaux_commandes?statut=eq.payee&select=metier,paye_le,montant_ttc&paye_le=gte.${LANCEMENT}`);
    const ventesPeriode = ventes.filter((v) => v.paye_le >= du);

    const metiers = Object.entries(GROUPES).map(([id, g]) => {
      const vC = ventes.filter((v) => v.metier === g.metier).length, vP = ventesPeriode.filter((v) => v.metier === g.metier).length;
      return {
        metier: g.nom,
        periode: { clics: periode[id].clics, impressions: periode[id].impressions, depense: +periode[id].cout.toFixed(2), ventes: vP },
        depuisLancement: { clics: cumul[id].clics, depense: +cumul[id].cout.toFixed(2), ventes: vC, coutParVente: vC ? +(cumul[id].cout / vC).toFixed(2) : null },
      };
    });
    const termes = {};
    for (const l of termesL) { const t = l.search_term_view_search_term; if (!t) continue; termes[t] = termes[t] || { recherche: t, metier: GROUPES[String(l.ad_group_id)]?.nom, clics: 0, depense: 0 }; termes[t].clics += +l.clicks || 0; termes[t].depense += +l.cost || 0; }
    const tot = (o, k) => Object.values(o).reduce((a, g) => a + g[k], 0);
    const donnees = {
      periode: `${du} au ${au}`, lancement: LANCEMENT,
      totaux2Jours: { depense: +tot(periode, 'cout').toFixed(2), clics: tot(periode, 'clics'), impressions: tot(periode, 'impressions'), ventes: ventesPeriode.length },
      totauxDepuisLancement: { depense: +tot(cumul, 'cout').toFixed(2), clics: tot(cumul, 'clics'), ventes: ventes.length },
      metiers,
      recherches: Object.values(termes).sort((a, b) => b.depense - a.depense).slice(0, 60).map((t) => ({ ...t, depense: +t.depense.toFixed(2) })),
      ventesSansSuiviGoogle: 'Les ventes viennent de la base Skyeco, toutes sources confondues (pas seulement Google Ads).',
    };

    const { synthese, appliquees } = await auditIA(donnees);

    await sb('agent_prix_travaux_audits', { method: 'POST', body: JSON.stringify({
      periode_debut: du, periode_fin: au, depenses: donnees.totaux2Jours.depense, clics: donnees.totaux2Jours.clics,
      impressions: donnees.totaux2Jours.impressions, ventes: ventesPeriode.length, chiffre_affaires: ventesPeriode.reduce((a, v) => a + Number(v.montant_ttc), 0),
      synthese, actions: appliquees, donnees,
    }) });

    // Rapport email
    const lignes = metiers.map((m) => `<tr><td>${esc(m.metier)}</td><td align="right">${m.periode.clics}</td><td align="right">${eur(m.periode.depense)}</td><td align="right">${m.periode.ventes}</td><td align="right">${m.depuisLancement.ventes}</td><td align="right">${m.depuisLancement.coutParVente == null ? '–' : eur(m.depuisLancement.coutParVente)}</td></tr>`).join('');
    const html = `<div style="font-family:Arial,sans-serif;color:#27394A;max-width:640px;line-height:1.5">
<p style="font-size:20px;font-weight:bold;color:#14304A;margin:0">SKY<span style="color:#E8622C">ECO</span> <span style="font-size:13px;color:#5B6268;font-weight:normal">Audit Google Ads, estimateur particuliers</span></p>
<p style="color:#5B6268;margin-top:4px">Période : ${du} au ${au}</p>
<p><strong>2 derniers jours :</strong> ${donnees.totaux2Jours.clics} clics, ${eur(donnees.totaux2Jours.depense)} dépensés, ${ventesPeriode.length} vente(s).<br>
<strong>Depuis le lancement :</strong> ${donnees.totauxDepuisLancement.clics} clics, ${eur(donnees.totauxDepuisLancement.depense)} dépensés, ${ventes.length} vente(s). Seuil de rentabilité : ${eur(PRIX_HT)} de pub par vente.</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:13px;width:100%"><tr style="background:#14304A;color:#fff"><th align="left">Métier</th><th>Clics 2 j</th><th>Dépense 2 j</th><th>Ventes 2 j</th><th>Ventes total</th><th>Coût / vente</th></tr>${lignes}</table>
<h3 style="color:#14304A">L'analyse de l'agent</h3><p style="white-space:pre-line">${esc(synthese)}</p>
<h3 style="color:#14304A">Actions appliquées automatiquement</h3><p>${appliquees.length ? appliquees.map((a) => `Recherches exclues : ${esc(a.termes.join(', '))} (${esc(a.raison)})`).join('<br>') : 'Aucune.'}</p>
<p style="font-size:12px;color:#8A949C">Agent Skyeco, audit automatique tous les 2 jours. Il ne peut qu'exclure des recherches inutiles : budget, pauses et nouveaux mots-clés restent ta décision.</p></div>`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Agent Skyeco <notifications@ecoskybyrms.fr>', to: [process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr'], subject: `Audit Skyeco : ${ventesPeriode.length} vente(s), ${eur(donnees.totaux2Jours.depense)} dépensés en 2 jours`, html }),
    });
    if (process.env.ADMIN_PHONE && process.env.TWILIO_FROM_NUMBER) {
      const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: process.env.ADMIN_PHONE, From: process.env.TWILIO_FROM_NUMBER, Body: `Audit Skyeco 2 jours : ${donnees.totaux2Jours.clics} clics, ${eur(donnees.totaux2Jours.depense)}, ${ventesPeriode.length} vente(s). ${appliquees.length ? appliquees[0].termes.length + ' recherche(s) exclue(s). ' : ''}Rapport complet par email.` }),
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true, ventes: ventesPeriode.length, actions: appliquees });
  } catch (e) {
    console.error('agent-prix-travaux :', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
