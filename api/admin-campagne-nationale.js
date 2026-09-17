// /api/admin-campagne-nationale.js
// Dashboard ADMIN (Cyrille uniquement) pour piloter la campagne Google Ads
// NATIONALE de recrutement d'artisans BTP (campagne id 24267076996, compte
// 784-990-3984) — distinct du dashboard artisan (mon-dashboard.html) qui
// gère les campagnes PAR ARTISAN pour les clients de Skyeco Ads. Cette
// campagne n'est rattachée à aucun draftId/compte artisan : pas de token
// de session ici, gate simple sur le mot de passe interne — même principe
// que mes-artisans.js / dashboard-admin-token.js (déjà utilisé ailleurs
// sur ce projet pour les outils réservés à Cyrille sans notion de client).
//
// Sécurité : ce endpoint contrôle une diffusion publicitaire réelle et
// son budget — voir l'historique de sécurité du 06/09 (bloquer-creneau.js
// et consorts) qui a ajouté une authentification partout où c'était
// manquant. Ici, TOUTE action (y compris "details", en lecture seule)
// exige le mot de passe interne, par cohérence et simplicité.
//
// Variables d'environnement requises : WINDSOR_API_KEY, INTERNAL_ACCESS_PASSWORD

import {
  CAMPAGNE,
  GROUPES_ANNONCES,
  trouverGroupe,
  executerAction,
  interrogerWindsor,
  eurosVersMicros,
} from './_lib/campagne-nationale.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { motDePasseInterne, action } = req.body || {};
  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne invalide.' });
  }

  try {
    switch (action) {
      case 'details':
        return res.status(200).json({ success: true, ...(await lireDetails()) });

      case 'toggle_campagne': {
        const { activer } = req.body;
        const suffixe = activer ? 'enable' : 'pause';
        // Cascade à 3 niveaux (campagne + chaque groupe + son annonce en
        // cours) — un bug historique de ce projet (corrigé le 03/09 dans
        // pause-campagne-ads.js) ne togglait QUE le niveau campagne, ce qui
        // laissait la diffusion invisible même "réactivée". On applique donc
        // toujours les 3 niveaux ensemble ici aussi.
        await executerAction(`${suffixe}_campaign`, { campaign_id: CAMPAGNE.id });
        for (const groupe of GROUPES_ANNONCES) {
          await executerAction(`${suffixe}_ad_group`, { ad_group_id: groupe.id });
          await executerAction(`${suffixe}_ad`, { ad_group_id: groupe.id, ad_id: groupe.adActuel.adId });
        }
        return res.status(200).json({
          success: true,
          message: activer
            ? 'Campagne, 3 groupes et 3 annonces activés. La diffusion réelle démarre maintenant.'
            : 'Campagne, groupes et annonces mis en pause. Le budget déjà engagé reste intact.',
        });
      }

      case 'toggle_groupe': {
        const { adGroupId, activer } = req.body;
        const groupe = trouverGroupe(adGroupId);
        if (!groupe) return res.status(400).json({ success: false, error: "Groupe d'annonces inconnu." });
        const suffixe = activer ? 'enable' : 'pause';
        await executerAction(`${suffixe}_ad_group`, { ad_group_id: groupe.id });
        await executerAction(`${suffixe}_ad`, { ad_group_id: groupe.id, ad_id: groupe.adActuel.adId });
        return res.status(200).json({
          success: true,
          message: `Groupe "${groupe.nom}" ${activer ? 'activé' : 'mis en pause'} (groupe + annonce en cours).`,
        });
      }

      case 'toggle_annonce': {
        const { adGroupId, adId, activer } = req.body;
        const groupe = trouverGroupe(adGroupId);
        if (!groupe) return res.status(400).json({ success: false, error: "Groupe d'annonces inconnu." });
        const suffixe = activer ? 'enable' : 'pause';
        await executerAction(`${suffixe}_ad`, { ad_group_id: groupe.id, ad_id: String(adId) });
        return res.status(200).json({ success: true, message: `Annonce ${activer ? 'activée' : 'mise en pause'}.` });
      }

      case 'definir_budget': {
        const montant = Number(req.body.montantEuros);
        if (!montant || montant <= 0) {
          return res.status(400).json({ success: false, error: 'Montant de budget invalide.' });
        }
        await executerAction('set_campaign_budget', {
          campaign_id: CAMPAGNE.id,
          budget_type: 'daily',
          amount_micros: eurosVersMicros(montant),
        });
        return res.status(200).json({ success: true, message: `Budget quotidien réglé à ${montant.toFixed(2)} €.` });
      }

      case 'exclure_terme': {
        const { texte, niveau, adGroupId } = req.body;
        const propre = (texte || '').trim();
        if (!propre) return res.status(400).json({ success: false, error: 'Terme à exclure manquant.' });

        if (niveau === 'groupe') {
          const groupe = trouverGroupe(adGroupId);
          if (!groupe) return res.status(400).json({ success: false, error: "Groupe d'annonces inconnu." });
          await executerAction('push_negative_keywords', {
            level: 'ad_group',
            ad_group_id: groupe.id,
            keywords: [{ text: propre, match_type: 'BROAD' }],
          });
          return res.status(200).json({ success: true, message: `"${propre}" exclu du groupe "${groupe.nom}".` });
        }

        await executerAction('push_negative_keywords', {
          level: 'campaign',
          campaign_id: CAMPAGNE.id,
          keywords: [{ text: propre, match_type: 'BROAD' }],
        });
        return res.status(200).json({ success: true, message: `"${propre}" exclu au niveau de toute la campagne.` });
      }

      default:
        return res.status(400).json({ success: false, error: 'Action inconnue.' });
    }
  } catch (err) {
    console.error('Erreur admin-campagne-nationale :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function lireDetails() {
  // Chaque lecture est indépendante et "best effort" — voir le commentaire
  // en tête de _lib/campagne-nationale.js : tant que la campagne n'a jamais
  // servi une impression, la plupart de ces rapports renvoient légitimement
  // un tableau vide (sauf le budget, qui a son propre rapport non lié aux
  // statistiques). Une lecture qui échoue n'empêche jamais les autres de
  // s'afficher.
  const [budgetLecture, motsClesLecture, termesLecture, heuresLecture] = await Promise.all([
    interrogerWindsor(['campaign_id', 'campaign', 'campaign_budget_status', 'budget_amount']),
    interrogerWindsor(['ad_group_id', 'keyword_criterion_id', 'keyword_text', 'keyword_match_type', 'keyword_status', 'clicks', 'cost']),
    interrogerWindsor(['ad_group_id', 'search_term_view_search_term', 'search_term_view_status', 'clicks', 'cost']),
    interrogerWindsor(['hour_of_day', 'clicks']),
  ]);

  const budget = budgetLecture.lignes[0] || null;

  const groupes = GROUPES_ANNONCES.map((g) => {
    const perf = motsClesLecture.lignes.filter((r) => String(r.ad_group_id) === g.id);
    const motsClesParId = new Map();
    for (const ligne of perf) {
      const id = ligne.keyword_criterion_id || ligne.keyword_text;
      if (!id) continue;
      if (!motsClesParId.has(id)) {
        motsClesParId.set(id, {
          texte: ligne.keyword_text || '(inconnu)',
          matchType: ligne.keyword_match_type || 'BROAD',
          statut: ligne.keyword_status || 'ENABLED',
          clics: 0,
          coutEuros: 0,
        });
      }
      const entree = motsClesParId.get(id);
      entree.clics += Number(ligne.clicks) || 0;
      entree.coutEuros += Number(ligne.cost) || 0;
    }
    return {
      id: g.id,
      nom: g.nom,
      motsCles: g.motsCles,
      adActuel: g.adActuel,
      anciennesAnnonces: g.anciennesAnnonces,
      performanceMotsCles: [...motsClesParId.values()]
        .map((m) => ({ ...m, coutEuros: +m.coutEuros.toFixed(2) }))
        .sort((a, b) => b.clics - a.clics),
    };
  });

  const termesParTexte = new Map();
  for (const ligne of termesLecture.lignes) {
    const texte = ligne.search_term_view_search_term;
    if (!texte) continue;
    if (!termesParTexte.has(texte)) {
      termesParTexte.set(texte, { texte, statut: ligne.search_term_view_status || 'NONE', clics: 0, coutEuros: 0 });
    }
    const entree = termesParTexte.get(texte);
    entree.clics += Number(ligne.clicks) || 0;
    entree.coutEuros += Number(ligne.cost) || 0;
  }
  const termesRecherche = [...termesParTexte.values()]
    .map((t) => ({ ...t, coutEuros: +t.coutEuros.toFixed(2) }))
    .sort((a, b) => b.clics - a.clics)
    .slice(0, 30);

  const clicsParHeure = Array(24).fill(0);
  for (const ligne of heuresLecture.lignes) {
    const heure = Number(ligne.hour_of_day);
    if (Number.isInteger(heure) && heure >= 0 && heure <= 23) {
      clicsParHeure[heure] += Number(ligne.clicks) || 0;
    }
  }

  return {
    campagne: CAMPAGNE,
    budget, // null tant qu'aucune donnée de budget n'est encore remontée
    groupes,
    termesRecherche,
    clicsParHeure,
    lectureLive: {
      budget: budgetLecture.ok,
      motsCles: motsClesLecture.ok,
      termesRecherche: termesLecture.ok,
      clicsParHeure: heuresLecture.ok,
    },
  };
}
