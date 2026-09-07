// /api/mes-artisans.js
//
// Remplace les lectures/écritures directes en clé anonyme que faisait
// public/mes-artisans.html sur skyeco_pro_vitrine_drafts et
// skyeco_pro_leads.
//
// Pourquoi ce fichier existe (06/09/2026) : la migration de verrouillage
// des colonnes sensibles de skyeco_pro_vitrine_drafts (voir
// verrouiller_colonnes_sensibles_vitrine_drafts) a retiré le SELECT anon
// sur dashboard_password_hash et l'UPDATE anon sur site_valide/archive.
// mes-artisans.html demandait directement dashboard_password_hash en
// clé anonyme pour savoir si un compte dashboard existait déjà — une
// requête PostgREST échoue intégralement si UNE SEULE colonne demandée
// n'est pas accordée, donc la liste entière ne se chargeait plus
// ("Impossible de charger la liste pour le moment."). Les bascules
// site_valide/archive (PATCH en clé anonyme) auraient échoué de la même
// façon au premier clic.
//
// Au passage, la page elle-même n'avait jusqu'ici AUCUN mot de passe pour
// consulter la liste (noms d'entreprise, téléphones...) — seules les
// actions de bascule le demandaient. Ce endpoint corrige aussi ça : toute
// lecture/écriture passe désormais par le même mot de passe interne
// (INTERNAL_ACCESS_PASSWORD) déjà utilisé ailleurs dans l'admin.
//
// Requête attendue : POST { motDePasseInterne, action, draftId? }
//   action = 'liste'          -> { success, fiches: [...], demandesParDraftId: {...} }
//   action = 'presence'       -> { success, presence: [{id, dashboard_dernier_ping}] }
//   action = 'toggle_valide'  -> { success, siteValide } (draftId requis)
//   action = 'toggle_archive' -> { success, archive } (draftId requis)
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// INTERNAL_ACCESS_PASSWORD

const COLONNES_LISTE = 'id,entreprise,metier,telephone,status,site_valide,archive,created_at,dashboard_password_hash,dashboard_dernier_ping';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { motDePasseInterne, action, draftId } = req.body || {};

  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    if (action === 'liste') {
      // est_demo=eq.false : exclut la fiche fictive créée le 07/09 pour
      // enregistrer une vidéo de démonstration (voir mon-dashboard.html,
      // bouton "🎬 Dashboard de démonstration") — elle ne doit pas polluer
      // les vraies statistiques/la vraie liste d'artisans.
      const [respFiches, respLeads] = await Promise.all([
        fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?select=${COLONNES_LISTE}&est_demo=eq.false&order=created_at.desc`, { headers: supaHeaders }),
        fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?select=draft_id`, { headers: supaHeaders }),
      ]);
      if (!respFiches.ok) throw new Error('Lecture fiches impossible : ' + (await respFiches.text()));
      const lignes = await respFiches.json();
      const leads = respLeads.ok ? await respLeads.json() : [];

      const demandesParDraftId = {};
      leads.forEach((l) => { demandesParDraftId[l.draft_id] = (demandesParDraftId[l.draft_id] || 0) + 1; });

      // dashboard_password_hash ne quitte jamais le serveur : on ne renvoie
      // qu'un booléen (c'est tout ce dont la page a besoin pour afficher
      // "Compte créé" / "Compte pas encore créé").
      const fiches = lignes.map(({ dashboard_password_hash, ...reste }) => ({
        ...reste,
        compte_cree: !!dashboard_password_hash,
      }));

      return res.status(200).json({ success: true, fiches, demandesParDraftId });
    }

    if (action === 'presence') {
      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?select=id,dashboard_dernier_ping`, { headers: supaHeaders });
      if (!resp.ok) throw new Error('Lecture présence impossible : ' + (await resp.text()));
      const presence = await resp.json();
      return res.status(200).json({ success: true, presence });
    }

    if (action === 'toggle_valide' || action === 'toggle_archive') {
      if (!draftId) return res.status(400).json({ success: false, error: 'draftId manquant' });
      const colonne = action === 'toggle_valide' ? 'site_valide' : 'archive';

      const lecture = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=${colonne}`, { headers: supaHeaders });
      if (!lecture.ok) throw new Error('Lecture impossible : ' + (await lecture.text()));
      const rows = await lecture.json();
      const fiche = rows[0];
      if (!fiche) return res.status(404).json({ success: false, error: 'introuvable' });

      const nouvelEtat = !fiche[colonne];
      const patch = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ [colonne]: nouvelEtat }),
      });
      if (!patch.ok) throw new Error('Écriture impossible : ' + (await patch.text()));

      return res.status(200).json({ success: true, [colonne === 'site_valide' ? 'siteValide' : 'archive']: nouvelEtat });
    }

    return res.status(400).json({ success: false, error: 'action inconnue' });
  } catch (err) {
    console.error('Erreur mes-artisans :', err);
    return res.status(500).json({ success: false, error: 'Impossible de traiter la demande pour le moment.' });
  }
}
