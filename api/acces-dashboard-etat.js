// /api/acces-dashboard-etat.js
//
// Remplace deux lectures directes en clé anonyme que faisait
// public/acces-dashboard.html sur skyeco_pro_vitrine_drafts.
//
// Pourquoi ce fichier existe (06/09/2026) : la migration de verrouillage
// des colonnes sensibles a retiré le SELECT anon sur
// dashboard_password_hash. acces-dashboard.html — la page qu'un artisan
// utilise pour CRÉER ou SAISIR son mot de passe de tableau de bord —
// demandait cette colonne directement en clé anonyme (juste pour savoir
// si un mot de passe existait déjà, jamais pour authentifier). Une
// requête PostgREST échoue intégralement si une colonne demandée n'est
// pas accordée : la page affichait "Site introuvable." pour absolument
// tous les artisans, alors que le site existe bel et bien.
//
// Requête attendue : POST { draftId }
// Réponse : { success, email, aDejaMotDePasse, elementsDeposes }
//   (jamais le hash lui-même, seulement les deux booléens dont la page a besoin)
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'Lien invalide.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=email,dashboard_password_hash,elements_deposes_le`,
      { headers: supaHeaders }
    );
    if (!resp.ok) throw new Error('Lecture Supabase impossible : ' + (await resp.text()));
    const rows = await resp.json();
    const draft = rows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'introuvable' });
    }

    return res.status(200).json({
      success: true,
      email: draft.email,
      aDejaMotDePasse: !!draft.dashboard_password_hash,
      elementsDeposes: !!draft.elements_deposes_le,
    });
  } catch (err) {
    console.error('Erreur acces-dashboard-etat :', err);
    return res.status(500).json({ success: false, error: "Impossible de charger la page pour le moment." });
  }
}
