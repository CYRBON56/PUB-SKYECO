// /api/valider-site.js
// Remplace la lecture/écriture directe (clé anonyme) que faisait
// public/valider-site.html sur skyeco_pro_vitrine_drafts.
//
// Requête attendue : POST { draftId, token, confirmer? }
//   - confirmer absent/false : renvoie l'état du site (entreprise, déjà
//     validé ou non) si "token" correspond à validation_token.
//   - confirmer: true : valide le site (site_valide = true) si "token"
//     correspond et qu'il n'est pas déjà validé.
//
// Sécurité (06/09/2026) : audit du schéma Supabase — skyeco_pro_vitrine_drafts
// avait des policies RLS grandes ouvertes (SELECT anon qual:true, UPDATE
// PUBLIC qual:true) SANS AUCUNE restriction de colonne, exposant en lecture
// ET EN ÉCRITURE à absolument n'importe qui, sans jeton ni mot de passe :
// dashboard_password_hash (donc la possibilité de prendre le contrôle du
// dashboard de N'IMPORTE QUEL artisan en lui écrasant son hash de mot de
// passe), stripe_subscription_id, subscription_status, status (activer/
// désactiver un site), budget_journalier_manuel, plafond_cpc_manuel, et
// bien d'autres colonnes de pilotage/facturation. Correctif complet : voir
// la migration verrouiller_colonnes_sensibles_vitrine_drafts (RLS + GRANT
// resserrés au strict nécessaire). Ce endpoint sert de remplacement pour le
// SEUL usage anonyme legitime restant identifié dans le code (ce fichier).
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token, confirmer } = req.body || {};
  if (!draftId || !token) {
    return res.status(400).json({ success: false, error: 'Lien invalide.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const lecture = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,site_valide,validation_token`,
      { headers: supaHeaders }
    );
    const rows = lecture.ok ? await lecture.json() : [];
    const draft = rows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'introuvable' });
    }
    if (draft.site_valide) {
      return res.status(200).json({ success: true, entreprise: draft.entreprise, dejaValide: true });
    }
    if (!draft.validation_token || draft.validation_token !== token) {
      return res.status(401).json({ success: false, error: 'lien_expire' });
    }

    if (!confirmer) {
      return res.status(200).json({ success: true, entreprise: draft.entreprise, dejaValide: false });
    }

    const patch = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ site_valide: true }),
    });
    if (!patch.ok) throw new Error('Écriture Supabase impossible : ' + (await patch.text()));

    return res.status(200).json({ success: true, entreprise: draft.entreprise, dejaValide: false, valide: true });
  } catch (err) {
    console.error('Erreur valider-site :', err);
    return res.status(500).json({ success: false, error: 'Impossible de valider pour le moment.' });
  }
}
