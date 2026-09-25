// /api/estimateur-btp-statut.js
// Revérifie l'état d'accès (essai en cours / expiré / abonné) d'un email pour
// l'Estimateur BTP — utilisé en tâche de fond par estimateur-btp.html quand
// une connexion réseau est disponible (l'appli reste utilisable hors ligne
// entre deux vérifications, avec le dernier état connu), et juste après un
// retour de paiement Stripe pour confirmer l'abonnement sans attendre le
// webhook.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

async function supabaseRequest(path) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const email = String(req.query?.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email manquant' });
  }

  try {
    const rows = await supabaseRequest(
      `estimateur_btp_acces?email=eq.${encodeURIComponent(email)}&select=email,essai_fin,abonnement_actif,source,reglages,overrides,postesPerso:postes_perso&limit=1`
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Aucun essai trouvé pour cet email' });
    }
    return res.status(200).json({ success: true, ...rows[0] });
  } catch (err) {
    console.error('estimateur-btp-statut error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
}
