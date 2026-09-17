// /api/_lib/coach-national-core.js
// Cœur du "coach IA" de la campagne Google Ads NATIONALE (recrutement
// d'artisans BTP pour Skyeco Ads, campagne id 24267076996, compte
// 784-990-3984) — demande de Cyrille du 17/09/2026 : "il faut une IA qui
// gère les campagnes [...] qui trouve les meilleurs mots-clés et fasse une
// synthèse quotidienne", avec le niveau d'autonomie "elle agit seule, avec
// garde-fous" et une synthèse affichée dans le dashboard.
//
// Directement calqué sur api/coach-ads.js (le coach IA déjà en prod pour les
// campagnes PAR ARTISAN, décision de Cyrille du 04/09 : "le coach peut agir
// seul, pas seulement conseiller") — même modèle Claude, même mécanique
// d'outils (tool use), mêmes principes de garde-fous. Deux différences
// structurelles :
//   1. Pas de draft_id/artisan : une seule campagne, 3 groupes d'annonces
//      fixes (voir campagne-nationale.js) au lieu d'un groupe unique par
//      client.
//   2. Le journal est écrit dans skyeco_national_coach_actions (nouvelle
//      table, même forme que skyeco_pro_coach_actions mais sans draft_id)
//      plutôt que dans la table partagée multi-artisans.
//
// Garde-fous (argent réel de Cyrille en jeu) :
//   - Seuls 3 outils sont exposés à l'IA : exclure un mot-clé (négatif),
//     ajouter un mot-clé (positif), ajuster le budget quotidien de la
//     campagne. AUCUN outil de pause/relance de la campagne, d'un groupe ou
//     d'une annonce — ce niveau-là reste un choix manuel de Cyrille via
//     l'interrupteur maître du dashboard (skyeco-admin-campagne-nationale.html) ;
//     ce n'est pas un oubli, l'IA ne doit jamais pouvoir couper ou relancer
//     la diffusion elle-même.
//   - Budget quotidien : un seul passage ne peut ni doubler ni diviser par
//     plus de 2 la valeur actuelle, et reste dans la fourchette absolue
//     5€–60€/jour (la campagne a démarré à 20€/jour). Une demande hors
//     bornes est plafonnée, jamais rejetée en silence.
//   - Au plus 4 actions appliquées automatiquement par passage.
//   - Chaque synthèse ET chaque action réellement appliquée sont
//     journalisées dans skyeco_national_coach_actions, relues par le
//     dashboard admin.
//   - Comme documenté dans campagne-nationale.js : tant que la campagne n'a
//     jamais servi une impression, Windsor.ai ne remonte aucune donnée de
//     performance. Le prompt le dit explicitement à l'IA pour qu'elle ne
//     s'affole pas devant des chiffres à zéro et adapte sa synthèse en
//     conséquence (ex : encourager l'activation plutôt que d'inventer une
//     analyse de clics qui n'existent pas).
//
// Variables d'environnement requises (toutes déjà en place sur ce projet) :
//   ANTHROPIC_API_KEY, WINDSOR_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { CAMPAGNE, GROUPES_ANNONCES, trouverGroupe, executerAction, interrogerWindsor, eurosVersMicros } from './campagne-nationale.js';

const MODELE_CLAUDE = 'claude-sonnet-4-6';
const MAX_ACTIONS_PAR_PASSAGE = 4;
const BORNES_BUDGET = { min: 5, max: 60 };

const TABLE_JOURNAL = 'skyeco_national_coach_actions';

function plafonnerValeur(actuelle, proposee, bornes) {
  let valeur = Number(proposee);
  let plafonne = false;
  if (!Number.isFinite(valeur)) { valeur = actuelle || bornes.min; plafonne = true; }
  if (actuelle && actuelle > 0) {
    const max = actuelle * 2;
    const min = actuelle / 2;
    if (valeur > max) { valeur = max; plafonne = true; }
    if (valeur < min) { valeur = min; plafonne = true; }
  }
  if (valeur > bornes.max) { valeur = bornes.max; plafonne = true; }
  if (valeur < bornes.min) { valeur = bornes.min; plafonne = true; }
  return { valeur: +valeur.toFixed(2), plafonne };
}

function supaHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Rassemble tout ce que l'IA doit voir pour analyser la campagne : budget,
// mots-clés positifs/négatifs et leur performance par groupe, termes de
// recherche réels, clics par heure. Chaque lecture est "best effort" (voir
// interrogerWindsor dans campagne-nationale.js) — un tableau vide est un
// résultat normal tant que la campagne n'a jamais servi.
async function chargerContexteCampagne() {
  const [budgetL, motsClesL, negatifsCampagneL, termesL, heuresL] = await Promise.all([
    interrogerWindsor(['campaign_id', 'campaign_budget_status', 'budget_amount']),
    interrogerWindsor(['ad_group_id', 'keyword_criterion_id', 'keyword_text', 'keyword_match_type', 'keyword_status', 'clicks', 'cost']),
    interrogerWindsor(['campaign_criterion_keyword_text', 'campaign_criterion_keyword_match_type', 'campaign_criterion_negative']),
    interrogerWindsor(['ad_group_id', 'search_term_view_search_term', 'search_term_view_status', 'clicks', 'cost']),
    interrogerWindsor(['hour_of_day', 'clicks']),
  ]);

  const budget = budgetL.lignes[0] || null;

  const groupes = GROUPES_ANNONCES.map((g) => {
    const perf = motsClesL.lignes.filter((r) => String(r.ad_group_id) === g.id);
    const motsClesParId = new Map();
    for (const l of perf) {
      const id = l.keyword_criterion_id || l.keyword_text;
      if (!id) continue;
      if (!motsClesParId.has(id)) {
        motsClesParId.set(id, { texte: l.keyword_text, matchType: l.keyword_match_type, statut: l.keyword_status, clics: 0, coutEuros: 0 });
      }
      const e = motsClesParId.get(id);
      e.clics += Number(l.clicks) || 0;
      e.coutEuros += Number(l.cost) || 0;
    }
    return {
      id: g.id,
      nom: g.nom,
      motsClesPositifsConfigures: g.motsCles,
      performanceMotsCles: [...motsClesParId.values()].map((m) => ({ ...m, coutEuros: +m.coutEuros.toFixed(2) })),
    };
  });

  const negatifsCampagne = negatifsCampagneL.lignes
    .filter((l) => l.campaign_criterion_negative === true || l.campaign_criterion_negative === 'true')
    .map((l) => l.campaign_criterion_keyword_text)
    .filter(Boolean);

  const termesParTexte = new Map();
  for (const l of termesL.lignes) {
    const texte = l.search_term_view_search_term;
    if (!texte) continue;
    if (!termesParTexte.has(texte)) termesParTexte.set(texte, { texte, statut: l.search_term_view_status, clics: 0, coutEuros: 0 });
    const e = termesParTexte.get(texte);
    e.clics += Number(l.clicks) || 0;
    e.coutEuros += Number(l.cost) || 0;
  }
  const termesRecherche = [...termesParTexte.values()]
    .map((t) => ({ ...t, coutEuros: +t.coutEuros.toFixed(2) }))
    .sort((a, b) => b.clics - a.clics)
    .slice(0, 30);

  const clicsParHeure = Array(24).fill(0);
  for (const l of heuresL.lignes) {
    const h = Number(l.hour_of_day);
    if (Number.isInteger(h) && h >= 0 && h <= 23) clicsParHeure[h] += Number(l.clicks) || 0;
  }

  const clicsTotal = clicsParHeure.reduce((s, c) => s + c, 0);
  const jamaisServie = clicsTotal === 0 && termesRecherche.length === 0;

  return {
    campagne: { id: CAMPAGNE.id, nom: CAMPAGNE.nom, geo: CAMPAGNE.geo, enchere: CAMPAGNE.enchere },
    budgetActuelEuros: budget?.budget_amount ?? CAMPAGNE.budgetQuotidienEurosCreation,
    groupes,
    negatifsCampagne,
    termesRecherche,
    clicsParHeure,
    jamaisServie,
  };
}

const OUTILS = [
  {
    name: 'exclure_mot_cle',
    description: "Exclut un mot-clé négatif au niveau de la campagne entière (bloque cette recherche sur les 3 groupes) : utile pour un terme de recherche réel qui coûte du budget sans intérêt pour recruter des artisans BTP.",
    input_schema: { type: 'object', properties: { texte: { type: 'string' } }, required: ['texte'] },
  },
  {
    name: 'ajouter_mot_cle',
    description: "Ajoute un mot-clé positif dans UN groupe d'annonces précis, pour élargir la couverture sur un sujet pertinent identifié (ex: une variante d'un terme de recherche qui a bien marché, ou une idée cohérente avec le thème du groupe).",
    input_schema: {
      type: 'object',
      properties: {
        groupeId: { type: 'string', enum: GROUPES_ANNONCES.map((g) => g.id), description: 'id du groupe cible, voir la liste des groupes fournie dans le contexte' },
        texte: { type: 'string' },
        matchType: { type: 'string', enum: ['BROAD', 'PHRASE', 'EXACT'] },
      },
      required: ['groupeId', 'texte'],
    },
  },
  {
    name: 'ajuster_budget_journalier',
    description: "Change le budget maximum (en €) que Google Ads peut dépenser par jour sur cette campagne. Une valeur trop éloignée de l'actuelle sera automatiquement plafonnée par le système (jamais plus du double, ni moins de la moitié, en un seul passage), et toujours entre 5€ et 60€/jour.",
    input_schema: { type: 'object', properties: { montant: { type: 'number' } }, required: ['montant'] },
  },
];

function construireSystemPrompt(contexte) {
  const noteActivite = contexte.jamaisServie
    ? "\n\nIMPORTANT : cette campagne n'a JAMAIS servi une seule impression pour l'instant (elle est peut-être encore en pause, ou vient d'être activée). Tous les chiffres de clics/coût sont donc à zéro — c'est normal, pas un problème à corriger. N'invente aucune analyse de performance qui n'existe pas : dans ce cas, ta synthèse doit plutôt rappeler l'état (campagne pas encore active ou trop récente), et tu peux éventuellement proposer 1-2 mots-clés supplémentaires pertinents pour le thème du groupe si tu en identifies un vraiment solide, mais reste très mesuré tant qu'il n'y a aucune donnée réelle à observer."
    : '';

  return `Tu es le coach publicitaire IA de Cyrille Bon (RMS EcoSky / Skyeco Ads) pour SA campagne Google Ads nationale, qui vise à recruter d'autres artisans du BTP comme clients du logiciel Skyeco Ads (pas une campagne de client à gérer pour quelqu'un d'autre : c'est directement l'argent de Cyrille).

DONNÉES ACTUELLES DE LA CAMPAGNE :
${JSON.stringify(contexte, null, 2)}${noteActivite}

TON RÔLE :
- Écris toujours, à la fin, une synthèse quotidienne en français simple et direct (3 à 6 phrases) : ce qui marche, ce qui ne marche pas, et ce que tu as fait ou recommandes. Pas de jargon, pas de tableau, du texte courant.
- Tu PEUX agir directement via tes outils (exclure un mot-clé, en ajouter un, ajuster le budget quotidien) quand les données le justifient clairement — pas besoin de demander la permission avant d'agir, mais explique ensuite dans ta synthèse ce que tu as fait et pourquoi.
- N'agis que si les données sont assez solides (au moins quelques clics ou un coût significatif sur la période) — dans le doute, recommande dans la synthèse sans agir.
- Ne fais jamais plus de 2-3 changements en un seul passage : mieux vaut peu d'actions bien justifiées.
- Tu n'as PAS d'outil pour mettre en pause ou activer la campagne, un groupe ou une annonce — c'est une décision qui reste toujours manuelle pour Cyrille, ne le suggère que dans le texte de ta synthèse si c'est pertinent, jamais comme une action que tu comptes faire toi-même.
- Reste factuel et constructif, jamais alarmiste : c'est du vrai budget publicitaire de Cyrille.`;
}

async function appellerClaude(system, messages) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODELE_CLAUDE, max_tokens: 1200, system, tools: OUTILS, messages }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

async function executerOutil(nom, input, contexteMutable, journal) {
  if (nom === 'exclure_mot_cle') {
    const texte = String(input.texte || '').trim();
    if (!texte) throw new Error('texte manquant');
    await executerAction('push_negative_keywords', {
      level: 'campaign',
      campaign_id: CAMPAGNE.id,
      keywords: [{ text: texte, match_type: 'BROAD' }],
    });
    journal.push({ type: 'action_appliquee', titre: 'Mot-clé exclu', contenu: `Mot-clé négatif ajouté au niveau de la campagne : "${texte}"`, action_type: 'exclure_mot_cle', action_params: { texte } });
    return `Mot-clé "${texte}" exclu avec succès au niveau de la campagne.`;
  }

  if (nom === 'ajouter_mot_cle') {
    const groupe = trouverGroupe(input.groupeId);
    if (!groupe) throw new Error("groupeId inconnu");
    const texte = String(input.texte || '').trim();
    if (!texte) throw new Error('texte manquant');
    const matchType = ['BROAD', 'PHRASE', 'EXACT'].includes(input.matchType) ? input.matchType : 'PHRASE';
    await executerAction('push_keywords', {
      ad_group_id: groupe.id,
      keywords: [{ text: texte, match_type: matchType }],
      status: 'enabled',
    });
    journal.push({ type: 'action_appliquee', titre: 'Mot-clé ajouté', contenu: `Nouveau mot-clé dans "${groupe.nom}" : "${texte}" (${matchType})`, action_type: 'ajouter_mot_cle', action_params: { groupeId: groupe.id, texte, matchType } });
    return `Mot-clé "${texte}" ajouté avec succès au groupe "${groupe.nom}".`;
  }

  if (nom === 'ajuster_budget_journalier') {
    const { valeur, plafonne } = plafonnerValeur(contexteMutable.budgetActuelEuros, input.montant, BORNES_BUDGET);
    await executerAction('set_campaign_budget', { campaign_id: CAMPAGNE.id, budget_type: 'daily', amount_micros: eurosVersMicros(valeur) });
    contexteMutable.budgetActuelEuros = valeur; // pour un éventuel 2e ajustement dans le même passage
    journal.push({ type: 'action_appliquee', titre: 'Budget quotidien ajusté', contenu: `Nouveau budget quotidien : ${valeur} €${plafonne ? ' (plafonné par le système de sécurité)' : ''}`, action_type: 'ajuster_budget_journalier', action_params: { montant: valeur } });
    return `Budget quotidien réglé à ${valeur} €.${plafonne ? ' (Plafonné automatiquement : jamais plus du double ni moins de la moitié en un passage, toujours entre 5€ et 60€/jour.)' : ''}`;
  }

  throw new Error(`Outil inconnu : ${nom}`);
}

// Point d'entrée unique, appelé aussi bien par le cron quotidien
// (api/coach-national-quotidien.js) que par le bouton "Lancer l'analyse
// maintenant" du dashboard admin (api/admin-campagne-nationale.js).
export async function lancerAnalyseEtAgir() {
  const contexte = await chargerContexteCampagne();
  const journal = [];

  const messages = [{
    role: 'user',
    content: "Analyse la campagne nationale et donne ta synthèse du jour. Agis directement si tu identifies une amélioration claire, dans la limite de tes outils et garde-fous.",
  }];

  let derniereReponse = null;
  let actionsAppliquees = 0;
  let tours = 0;
  const MAX_TOURS_OUTILS = 6;

  while (tours < MAX_TOURS_OUTILS) {
    tours++;
    const data = await appellerClaude(construireSystemPrompt(contexte), messages);
    messages.push({ role: 'assistant', content: data.content });

    const blocsTexte = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (blocsTexte) derniereReponse = blocsTexte;

    const appelsOutils = (data.content || []).filter((b) => b.type === 'tool_use');
    if (!appelsOutils.length) break;

    const resultatsOutils = [];
    for (const appel of appelsOutils) {
      let resultatTexte;
      if (actionsAppliquees >= MAX_ACTIONS_PAR_PASSAGE) {
        resultatTexte = `Limite atteinte : pas plus de ${MAX_ACTIONS_PAR_PASSAGE} actions automatiques par passage. Termine ta synthèse sans agir davantage.`;
      } else {
        try {
          resultatTexte = await executerOutil(appel.name, appel.input, contexte, journal);
          actionsAppliquees++;
        } catch (err) {
          resultatTexte = `Échec de l'action : ${err.message}`;
        }
      }
      resultatsOutils.push({ type: 'tool_result', tool_use_id: appel.id, content: resultatTexte });
    }
    messages.push({ role: 'user', content: resultatsOutils });
  }

  if (derniereReponse) {
    journal.push({ type: 'synthese', titre: 'Synthèse quotidienne', contenu: derniereReponse });
  }

  if (journal.length) {
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${TABLE_JOURNAL}`, {
      method: 'POST',
      headers: { ...supaHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(journal),
    });
    if (!resp.ok) console.error('Erreur écriture journal coach national :', await resp.text());
  }

  return { synthese: derniereReponse, actionsAppliquees };
}

// Lit le journal récent pour l'affichage dans le dashboard admin (dernière
// synthèse + N dernières actions appliquées).
export async function lireJournalRecent(limite = 30) {
  const resp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/${TABLE_JOURNAL}?order=cree_le.desc&limit=${limite}&select=type,titre,contenu,action_type,action_params,cree_le`,
    { headers: supaHeaders() }
  );
  if (!resp.ok) return { derniereSynthese: null, actions: [] };
  const lignes = await resp.json();
  const derniereSynthese = lignes.find((l) => l.type === 'synthese') || null;
  const actions = lignes.filter((l) => l.type === 'action_appliquee');
  return { derniereSynthese, actions };
}
