// /api/coach-ads.js
// Coach IA Ads pour le dashboard artisan (mon-dashboard.html) : remplace les
// "conseils" purement statiques (règles JS codées en dur dans afficherCoaching)
// par une vraie analyse Claude de la campagne Google Ads en cours, capable
// aussi bien de conseiller que d'agir directement sur la campagne (exclure un
// mot-clé, ajuster le budget journalier ou le plafond de CPC, mettre en pause/
// relancer) — décision de Cyrille du 04/09 : le coach peut agir seul, pas
// seulement conseiller.
//
// Deux modes, même endpoint :
//   - Sans "message" : analyse automatique au chargement du panneau, produit
//     des recommandations (et peut agir directement si pertinent).
//   - Avec "message" : question libre de l'artisan, réponse en tenant compte
//     de l'historique de la conversation (table skyeco_pro_coach_actions).
//
// Garde-fous (argent réel en jeu, donc jamais d'action illimitée) :
//   - Seules 5 actions sont exposées à l'IA : exclure/ajouter un mot-clé,
//     ajuster le budget journalier, ajuster le plafond de CPC, mettre en
//     pause/relancer la diffusion. Rien d'autre (pas de suppression de
//     campagne, pas de changement de ciblage, pas de texte d'annonce).
//   - Budget journalier et plafond CPC : un seul appel ne peut ni doubler ni
//     diviser par plus de 2 la valeur actuelle, et reste dans des bornes
//     absolues raisonnables (budget 1€–100€, CPC 0,05€–10€). Une demande hors
//     bornes est plafonnée, jamais rejetée en silence : le coach explique la
//     limite appliquée à l'artisan.
//   - Au plus 3 actions appliquées automatiquement par appel (évite un
//     enchaînement incontrôlé).
//   - Chaque recommandation ET chaque action réellement appliquée sont
//     journalisées dans skyeco_pro_coach_actions (traçabilité complète,
//     visible aussi par Cyrille).
//
// Variables d'environnement requises :
//   ANTHROPIC_API_KEY, WINDSOR_API_KEY, GOOGLE_ADS_ACCOUNT_ID
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const MODELE_CLAUDE = 'claude-sonnet-4-6';
const WINDSOR_BASE = 'https://connectors.windsor.ai/google_ads';
const MAX_ACTIONS_PAR_APPEL = 3;
const MAX_TOURS_OUTILS = 5; // filet de sécurité contre une boucle d'appels d'outils

const BORNES_BUDGET = { min: 1, max: 100 };
const BORNES_CPC = { min: 0.05, max: 10 };

function formaterCompteGoogleAds(id) {
  const chiffres = String(id || '').replace(/[^0-9]/g, '');
  if (chiffres.length !== 10) return String(id || '').trim();
  return `${chiffres.slice(0, 3)}-${chiffres.slice(3, 6)}-${chiffres.slice(6)}`;
}

async function executerActionWindsor(action, params) {
  const accountId = formaterCompteGoogleAds(process.env.GOOGLE_ADS_ACCOUNT_ID);
  const resp = await fetch(`${WINDSOR_BASE}/actions?api_key=${process.env.WINDSOR_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: accountId, action, params }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Action Windsor.ai "${action}" échouée : ${JSON.stringify(data)}`);
  return data;
}

async function interrogerWindsorLecture(campaignId, fields, dateDepart) {
  const filtre = encodeURIComponent(JSON.stringify([['campaign_id', 'eq', campaignId]]));
  let url = `${WINDSOR_BASE}?api_key=${process.env.WINDSOR_API_KEY}&fields=${fields}&filter=${filtre}`;
  url += dateDepart ? `&date_from=${dateDepart}` : `&date_preset=last_30d`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Windsor.ai a répondu une erreur : ${JSON.stringify(data)}`);
  return data.data || [];
}

// Plafonne une valeur proposée par l'IA : bornes absolues + jamais plus du
// double ni moins de la moitié de la valeur actuelle en un seul appel.
function plafonnerValeur(actuelle, proposee, bornes) {
  let valeur = proposee;
  let plafonne = false;
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

async function chargerContexteCampagne(supaHeaders, draftId) {
  const draftResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,google_ads_campaign_resource,google_ads_ad_group_resource,google_ads_ad_resource,tarif_prix,derniere_recharge_le,budget_journalier_manuel,plafond_cpc_manuel,campagne_diffusion_pausee,coach_ia_pause`,
    { headers: supaHeaders }
  );
  const rows = await draftResp.json();
  const draft = rows[0];
  if (!draft?.google_ads_campaign_resource) return { draft, campagneExiste: false };

  // Le coach est mis en pause par l'artisan lui-même (api/coach-toggle.js) :
  // on ne fait alors AUCUN appel à Claude ni à Windsor.ai (ni analyse
  // automatique, ni chat, ni action) — on s'arrête ici, avant même
  // d'interroger les données de campagne, pour ne pas gaspiller d'appels
  // inutiles.
  if (draft.coach_ia_pause) return { draft, campagneExiste: true, coachEnPause: true };

  const dateDepart = draft.derniere_recharge_le
    ? new Date(draft.derniere_recharge_le).toISOString().slice(0, 10)
    : undefined;

  const [lignesSpend, lignesMotsCles, lignesTermes, lignesAppareils, lignesHeures] = await Promise.all([
    interrogerWindsorLecture(draft.google_ads_campaign_resource, 'clicks,cost', dateDepart),
    interrogerWindsorLecture(draft.google_ads_campaign_resource, 'keyword_criterion_id,keyword_text,keyword_match_type,keyword_status,clicks,cost', dateDepart),
    interrogerWindsorLecture(draft.google_ads_campaign_resource, 'search_term_view_search_term,search_term_view_status,clicks,cost', dateDepart),
    interrogerWindsorLecture(draft.google_ads_campaign_resource, 'device,clicks,cost', dateDepart),
    interrogerWindsorLecture(draft.google_ads_campaign_resource, 'hour_of_day,clicks', dateDepart),
  ]);

  const clics = lignesSpend.reduce((s, l) => s + (Number(l.clicks) || 0), 0);
  const coutEuros = +lignesSpend.reduce((s, l) => s + (Number(l.cost) || 0), 0).toFixed(2);

  const motsClesParId = new Map();
  for (const l of lignesMotsCles) {
    const id = l.keyword_criterion_id || l.keyword_text;
    if (!id) continue;
    if (!motsClesParId.has(id)) {
      motsClesParId.set(id, { id: l.keyword_criterion_id || null, texte: l.keyword_text, matchType: l.keyword_match_type, statut: l.keyword_status, clics: 0, coutEuros: 0 });
    }
    const e = motsClesParId.get(id);
    e.clics += Number(l.clicks) || 0;
    e.coutEuros += Number(l.cost) || 0;
  }
  const motsCles = [...motsClesParId.values()].map(m => ({ ...m, coutEuros: +m.coutEuros.toFixed(2) })).sort((a, b) => b.clics - a.clics);

  const termesParTexte = new Map();
  for (const l of lignesTermes) {
    const texte = l.search_term_view_search_term;
    if (!texte) continue;
    if (!termesParTexte.has(texte)) termesParTexte.set(texte, { texte, statut: l.search_term_view_status, clics: 0, coutEuros: 0 });
    const e = termesParTexte.get(texte);
    e.clics += Number(l.clicks) || 0;
    e.coutEuros += Number(l.cost) || 0;
  }
  const termesRecherche = [...termesParTexte.values()].map(t => ({ ...t, coutEuros: +t.coutEuros.toFixed(2) })).sort((a, b) => b.clics - a.clics).slice(0, 20);

  const appareilsParType = new Map();
  for (const l of lignesAppareils) {
    if (!l.device) continue;
    if (!appareilsParType.has(l.device)) appareilsParType.set(l.device, { type: l.device, clics: 0, coutEuros: 0 });
    const e = appareilsParType.get(l.device);
    e.clics += Number(l.clicks) || 0;
    e.coutEuros += Number(l.cost) || 0;
  }
  const appareils = [...appareilsParType.values()].map(a => ({ ...a, coutEuros: +a.coutEuros.toFixed(2) }));

  const clicsParHeure = Array(24).fill(0);
  for (const l of lignesHeures) {
    const h = Number(l.hour_of_day);
    if (Number.isInteger(h) && h >= 0 && h <= 23) clicsParHeure[h] += Number(l.clicks) || 0;
  }

  return {
    draft,
    campagneExiste: true,
    resume: {
      entreprise: draft.entreprise,
      clics,
      coutEuros,
      budgetMensuelPaye: draft.tarif_prix || null,
      budgetJournalierActuel: draft.budget_journalier_manuel || null,
      plafondCpcActuel: draft.plafond_cpc_manuel || null,
      diffusionEnPause: !!draft.campagne_diffusion_pausee,
      motsCles,
      termesRecherche,
      appareils,
      clicsParHeure,
    },
  };
}

const OUTILS = [
  {
    name: 'exclure_mot_cle',
    description: "Exclut un mot-clé négatif sur le groupe d'annonces : bloque les recherches contenant ce terme, sans toucher au reste. À utiliser pour un mot-clé ou terme de recherche qui coûte du budget sans générer de clics pertinents.",
    input_schema: { type: 'object', properties: { texte: { type: 'string' } }, required: ['texte'] },
  },
  {
    name: 'ajouter_mot_cle',
    description: "Ajoute un mot-clé positif (déclenche les annonces) pour élargir la couverture de la campagne sur un sujet pertinent identifié dans les données.",
    input_schema: { type: 'object', properties: { texte: { type: 'string' }, matchType: { type: 'string', enum: ['BROAD', 'PHRASE', 'EXACT'] } }, required: ['texte'] },
  },
  {
    name: 'ajuster_budget_journalier',
    description: "Change le montant maximum (en €) que Google Ads peut dépenser par jour sur cette campagne. Une valeur trop éloignée de l'actuelle sera automatiquement plafonnée par le système (jamais plus du double, ni moins de la moitié, en un seul appel).",
    input_schema: { type: 'object', properties: { montant: { type: 'number' } }, required: ['montant'] },
  },
  {
    name: 'ajuster_plafond_cpc',
    description: "Change le prix maximum (en €) accepté pour un clic sur cette campagne. Même plafonnement automatique que le budget journalier.",
    input_schema: { type: 'object', properties: { montant: { type: 'number' } }, required: ['montant'] },
  },
  {
    name: 'mettre_en_pause_ou_relancer',
    description: "Met en pause ou relance la diffusion de la campagne (n'affecte pas l'abonnement ni le solde déjà payé).",
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'relancer'] } }, required: ['action'] },
  },
];

function construireSystemPrompt(resume) {
  return `Tu es le coach publicitaire IA de Skyeco Pro, intégré dans le tableau de bord de l'artisan "${resume.entreprise || 'un artisan'}". Tu analyses sa campagne Google Ads et tu l'aides à obtenir plus de demandes de devis pour son budget.

DONNÉES ACTUELLES DE SA CAMPAGNE (dernière période de facturation) :
${JSON.stringify(resume, null, 2)}

TON RÔLE :
- Analyse ces données et donne des conseils concrets, en français simple, sans jargon technique — l'artisan n'y connaît rien en publicité.
- Tu PEUX agir directement via les outils à ta disposition (exclure un mot-clé inefficace, ajuster le budget journalier ou le plafond de CPC, mettre en pause/relancer) quand c'est clairement bénéfique — pas besoin de demander la permission avant d'agir, mais explique TOUJOURS ensuite ce que tu as fait et pourquoi, en une phrase simple.
- N'agis que si les données sont assez solides pour justifier un changement (au moins quelques clics ou un coût significatif) — dans le doute, conseille sans agir.
- Ne propose jamais plus de 2-3 changements à la fois : mieux vaut peu d'actions bien justifiées qu'une longue liste.
- Reste toujours positif et encourageant, jamais alarmiste — c'est le budget réel de l'artisan qui est en jeu, il doit se sentir accompagné, pas jugé.
- Si l'artisan te pose une question libre, réponds-y directement en t'appuyant sur ses vraies données ci-dessus.`;
}

async function appellerClaude(system, messages) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELE_CLAUDE,
      max_tokens: 1024,
      system,
      tools: OUTILS,
      messages,
    }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, message } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const { draft, campagneExiste, coachEnPause, resume } = await chargerContexteCampagne(supaHeaders, draftId);

    if (!campagneExiste) {
      return res.status(200).json({ success: true, campagneExiste: false, reponse: null, recommandations: [], actionsAppliquees: [] });
    }

    // Coach mis en pause par l'artisan : aucun appel Claude/Windsor.ai,
    // qu'il s'agisse de l'analyse automatique ou d'un message de chat.
    if (coachEnPause) {
      return res.status(200).json({ success: true, campagneExiste: true, coachEnPause: true, reponse: null, actionsAppliquees: 0 });
    }

    // Historique récent (pour la continuité du chat) — les 20 derniers échanges.
    const histoResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_coach_actions?draft_id=eq.${draftId}&type=in.(message_artisan,message_coach)&order=cree_le.desc&limit=20&select=type,contenu`,
      { headers: supaHeaders }
    );
    const historique = (await histoResp.json()).reverse();

    const messages = historique.map(h => ({
      role: h.type === 'message_artisan' ? 'user' : 'assistant',
      content: h.contenu,
    }));

    const journal = []; // { type, titre?, contenu, action_type?, action_params? } à écrire en base

    if (message) {
      messages.push({ role: 'user', content: message });
      journal.push({ type: 'message_artisan', contenu: message });
    } else {
      messages.push({ role: 'user', content: "Analyse ma campagne et donne-moi tes recommandations pour ce mois-ci. Agis directement si tu identifies une amélioration claire." });
    }

    const systemPrompt = construireSystemPrompt(resume);
    let actionsAppliquees = 0;
    let derniereReponse = null;
    let tours = 0;

    while (tours < MAX_TOURS_OUTILS) {
      tours++;
      const data = await appellerClaude(systemPrompt, messages);
      messages.push({ role: 'assistant', content: data.content });

      const blocsTexte = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (blocsTexte) derniereReponse = blocsTexte;

      const appelsOutils = (data.content || []).filter(b => b.type === 'tool_use');
      if (!appelsOutils.length) break; // Claude a fini de répondre

      const resultatsOutils = [];
      for (const appel of appelsOutils) {
        let resultatTexte;
        if (actionsAppliquees >= MAX_ACTIONS_PAR_APPEL) {
          resultatTexte = "Limite atteinte : pas plus de 3 actions automatiques par analyse. Explique à l'artisan qu'il peut redemander une analyse pour continuer.";
        } else {
          try {
            resultatTexte = await executerOutil(appel.name, appel.input, draft, supaHeaders, journal);
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
      journal.push({ type: message ? 'message_coach' : 'recommandation', contenu: derniereReponse });
    }

    // Écrit tout le journal de cet échange en une fois.
    if (journal.length) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_coach_actions`, {
        method: 'POST',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(journal.map(j => ({ draft_id: draftId, ...j }))),
      });
    }

    return res.status(200).json({
      success: true,
      campagneExiste: true,
      reponse: derniereReponse,
      actionsAppliquees,
    });
  } catch (err) {
    console.error('Erreur coach-ads :', err);
    return res.status(500).json({ success: false, error: err.message || "Le coach n'est pas disponible pour le moment." });
  }
}

// Exécute un outil demandé par Claude, applique les garde-fous, journalise
// l'action, et renvoie un texte de résultat (relu par Claude pour formuler sa
// réponse finale à l'artisan).
async function executerOutil(nom, input, draft, supaHeaders, journal) {
  if (nom === 'exclure_mot_cle') {
    await executerActionWindsor('push_negative_keywords', {
      level: 'ad_group',
      ad_group_id: draft.google_ads_ad_group_resource,
      keywords: [{ text: input.texte.trim(), match_type: 'PHRASE' }],
    });
    journal.push({ type: 'action_appliquee', titre: 'Mot-clé exclu', contenu: `Mot-clé négatif ajouté : "${input.texte}"`, action_type: 'exclure_mot_cle', action_params: input });
    return `Mot-clé "${input.texte}" exclu avec succès.`;
  }

  if (nom === 'ajouter_mot_cle') {
    const matchType = ['BROAD', 'PHRASE', 'EXACT'].includes(input.matchType) ? input.matchType : 'PHRASE';
    await executerActionWindsor('push_keywords', {
      ad_group_id: draft.google_ads_ad_group_resource,
      keywords: [{ text: input.texte.trim(), match_type: matchType }],
      status: 'enabled',
    });
    journal.push({ type: 'action_appliquee', titre: 'Mot-clé ajouté', contenu: `Nouveau mot-clé : "${input.texte}"`, action_type: 'ajouter_mot_cle', action_params: input });
    return `Mot-clé "${input.texte}" ajouté avec succès.`;
  }

  if (nom === 'ajuster_budget_journalier') {
    const { valeur, plafonne } = plafonnerValeur(draft.budget_journalier_manuel, Number(input.montant), BORNES_BUDGET);
    const montantMicros = Math.round(valeur * 100) * 10_000;
    await executerActionWindsor('set_campaign_budget', { campaign_id: draft.google_ads_campaign_resource, budget_type: 'daily', amount_micros: montantMicros });
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
      method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ budget_journalier_manuel: valeur }),
    });
    draft.budget_journalier_manuel = valeur; // pour un éventuel 2e ajustement dans le même échange
    journal.push({ type: 'action_appliquee', titre: 'Budget journalier ajusté', contenu: `Nouveau budget journalier : ${valeur} €${plafonne ? ' (plafonné par le système de sécurité)' : ''}`, action_type: 'ajuster_budget_journalier', action_params: { montant: valeur } });
    return `Budget journalier réglé à ${valeur} €.${plafonne ? " (Plafonné automatiquement — un seul ajustement ne peut pas dépasser le double ni descendre sous la moitié de la valeur précédente, ni sortir de la fourchette 1€-100€.)" : ''}`;
  }

  if (nom === 'ajuster_plafond_cpc') {
    const { valeur, plafonne } = plafonnerValeur(draft.plafond_cpc_manuel, Number(input.montant), BORNES_CPC);
    const montantMicros = Math.round(valeur * 100) * 10_000;
    await executerActionWindsor('set_max_cpc', { ad_group_id: draft.google_ads_ad_group_resource, amount_micros: montantMicros });
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
      method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ plafond_cpc_manuel: valeur }),
    });
    draft.plafond_cpc_manuel = valeur;
    journal.push({ type: 'action_appliquee', titre: 'Plafond de CPC ajusté', contenu: `Nouveau plafond par clic : ${valeur} €${plafonne ? ' (plafonné par le système de sécurité)' : ''}`, action_type: 'ajuster_plafond_cpc', action_params: { montant: valeur } });
    return `Plafond de CPC réglé à ${valeur} €.${plafonne ? " (Plafonné automatiquement pour rester dans une fourchette sûre.)" : ''}`;
  }

  if (nom === 'mettre_en_pause_ou_relancer') {
    const suffixe = input.action === 'pause' ? 'pause' : 'enable';
    await executerActionWindsor(`${suffixe}_campaign`, { campaign_id: draft.google_ads_campaign_resource });
    if (draft.google_ads_ad_group_resource) await executerActionWindsor(`${suffixe}_ad_group`, { ad_group_id: draft.google_ads_ad_group_resource });
    if (draft.google_ads_ad_resource && draft.google_ads_ad_resource.includes('~')) {
      const [adGroupIdPourAnnonce, adId] = draft.google_ads_ad_resource.split('~');
      await executerActionWindsor(`${suffixe}_ad`, { ad_group_id: adGroupIdPourAnnonce, ad_id: adId });
    }
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft.id}`, {
      method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ campagne_diffusion_pausee: input.action === 'pause', campagne_pausee_budget_epuise: false }),
    });
    journal.push({ type: 'action_appliquee', titre: input.action === 'pause' ? 'Diffusion mise en pause' : 'Diffusion relancée', contenu: input.action === 'pause' ? 'Diffusion mise en pause par le coach IA.' : 'Diffusion relancée par le coach IA.', action_type: 'mettre_en_pause_ou_relancer', action_params: input });
    return input.action === 'pause' ? 'Diffusion mise en pause.' : 'Diffusion relancée.';
  }

  throw new Error(`Outil inconnu : ${nom}`);
}
