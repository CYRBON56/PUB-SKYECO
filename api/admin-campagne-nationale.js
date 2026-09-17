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
// (+ celles de coach-national-core.js pour l'action 'lancer_analyse_ia' :
// ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

import {
  CAMPAGNE,
  GROUPES_ANNONCES,
  trouverGroupe,
  executerAction,
  interrogerWindsor,
  eurosVersMicros,
} from './_lib/campagne-nationale.js';
import { lancerAnalyseEtAgir, lireJournalRecent } from './_lib/coach-national-core.js';

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

      case 'ajouter_mot_cle': {
        const { adGroupId, texte, matchType } = req.body;
        const groupe = trouverGroupe(adGroupId);
        if (!groupe) return res.status(400).json({ success: false, error: "Groupe d'annonces inconnu." });
        const propre = (texte || '').trim();
        if (!propre) return res.status(400).json({ success: false, error: 'Mot-clé manquant.' });
        const mt = ['BROAD', 'PHRASE', 'EXACT'].includes(matchType) ? matchType : 'PHRASE';
        await executerAction('push_keywords', {
          ad_group_id: groupe.id,
          keywords: [{ text: propre, match_type: mt }],
          status: 'enabled',
        });
        return res.status(200).json({ success: true, message: `Mot-clé "${propre}" ajouté au groupe "${groupe.nom}".` });
      }

      // Lance manuellement le coach IA (mêmes garde-fous et mêmes 3 outils
      // que le passage automatique quotidien, voir coach-national-core.js) —
      // bouton "Lancer l'analyse maintenant" du dashboard. Peut être
      // relativement lent (plusieurs allers-retours avec Claude) : c'est
      // normal, pas une erreur si la réponse met quelques secondes.
      case 'lancer_analyse_ia': {
        const resultat = await lancerAnalyseEtAgir();
        return res.status(200).json({
          success: true,
          message: resultat.actionsAppliquees > 0
            ? `Analyse terminée : ${resultat.actionsAppliquees} action(s) appliquée(s). Synthèse mise à jour.`
            : 'Analyse terminée, aucune action appliquée cette fois. Synthèse mise à jour.',
        });
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
  const [budgetLecture, motsClesLecture, negatifsLecture, termesLecture, heuresLecture, annoncesLecture, journal] = await Promise.all([
    // campaign_primary_status / _reasons : le VRAI statut de diffusion côté
    // Google Ads (ENABLED/PAUSED/... + pourquoi), à ne pas confondre avec
    // campaign_budget_status (qui ne dit que si le BUDGET est actif). Ajouté
    // le 17/09 (soir) suite à une remarque justifiée de Cyrille : le badge du
    // dashboard reflétait jusqu'ici seulement le dernier bouton cliqué dans
    // CE dashboard (mémorisé dans le navigateur), pas la réalité de Google
    // Ads — deux choses qui peuvent diverger (ex : action manuelle faite
    // directement dans Google Ads, échec silencieux d'un appel précédent).
    interrogerWindsor(['campaign_id', 'campaign', 'campaign_budget_status', 'budget_amount', 'campaign_primary_status', 'campaign_primary_status_reasons']),
    interrogerWindsor(['ad_group_id', 'keyword_criterion_id', 'keyword_text', 'keyword_match_type', 'keyword_status', 'clicks', 'cost']),
    interrogerWindsor(['campaign_criterion_keyword_text', 'campaign_criterion_keyword_match_type', 'campaign_criterion_negative']),
    interrogerWindsor(['ad_group_id', 'search_term_view_search_term', 'search_term_view_status', 'clicks', 'cost']),
    interrogerWindsor(['hour_of_day', 'clicks']),
    // Contenu réel des annonces (titres/descriptions/chemins d'affichage tels
    // que configurés dans Google Ads) — sert à afficher un aperçu fidèle de
    // l'annonce dans le dashboard (demande de Cyrille : voir les annonces
    // "comme sur Internet", pas juste l'URL de destination et l'id).
    interrogerWindsor([
      'ad_group_id', 'ad_id',
      'ad_responsive_search_ad_headlines_combined_text',
      'ad_responsive_search_ad_descriptions_combined_text',
      'ad_responsive_search_ad_path1',
      'ad_responsive_search_ad_path2',
    ]),
    lireJournalRecent(30),
  ]);

  // Une ligne par annonce suffit (le rapport peut renvoyer plusieurs lignes
  // identiques si joint à des statistiques quotidiennes) — on garde la
  // première rencontrée par ad_id.
  const contenuParAdId = new Map();
  for (const ligne of annoncesLecture.lignes) {
    const id = ligne.ad_id;
    if (!id || contenuParAdId.has(String(id))) continue;
    const titres = (ligne.ad_responsive_search_ad_headlines_combined_text || '').split('|').map((s) => s.trim()).filter(Boolean);
    const descriptions = (ligne.ad_responsive_search_ad_descriptions_combined_text || '').split('|').map((s) => s.trim()).filter(Boolean);
    contenuParAdId.set(String(id), {
      titres,
      descriptions,
      chemin1: ligne.ad_responsive_search_ad_path1 || '',
      chemin2: ligne.ad_responsive_search_ad_path2 || '',
    });
  }

  const negatifsCampagne = negatifsLecture.lignes
    .filter((l) => l.campaign_criterion_negative === true || l.campaign_criterion_negative === 'true')
    .map((l) => ({ texte: l.campaign_criterion_keyword_text, matchType: l.campaign_criterion_keyword_match_type }))
    .filter((n) => n.texte);

  const budget = budgetLecture.lignes[0] || null;

  // Statut réel de diffusion (voir commentaire sur la lecture ci-dessus).
  // campaign_primary_status_reasons revient sous forme de chaîne JSON
  // (ex: '["CAMPAIGN_PAUSED", "MOST_ADS_UNDER_REVIEW"]') — jamais laisser un
  // format inattendu casser toute la réponse.
  let raisonsStatutReel = [];
  try {
    raisonsStatutReel = JSON.parse(budget?.campaign_primary_status_reasons || '[]');
    if (!Array.isArray(raisonsStatutReel)) raisonsStatutReel = [];
  } catch (e) {
    raisonsStatutReel = [];
  }
  const statutReelCampagne = {
    primaryStatus: budget?.campaign_primary_status || null,
    raisons: raisonsStatutReel,
  };

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
      adActuel: {
        ...g.adActuel,
        // Priorité à la lecture live Windsor.ai ; repli sur le contenu tel
        // que configuré à la création si Windsor n'a pas encore synchronisé
        // ce niveau de détail pour cette campagne (voir le commentaire sur
        // CONTENU_ANNONCE_A dans _lib/campagne-nationale.js).
        contenu: contenuParAdId.get(String(g.adActuel.adId)) || g.adActuel.contenuConfigure || null,
        contenuEnDirect: contenuParAdId.has(String(g.adActuel.adId)),
      },
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
    statutReelCampagne,
    groupes,
    termesRecherche,
    clicsParHeure,
    negatifsCampagne,
    derniereSynthese: journal.derniereSynthese,
    actionsIA: journal.actions,
    lectureLive: {
      budget: budgetLecture.ok,
      motsCles: motsClesLecture.ok,
      negatifs: negatifsLecture.ok,
      termesRecherche: termesLecture.ok,
      clicsParHeure: heuresLecture.ok,
      annonces: annoncesLecture.ok,
    },
  };
}
