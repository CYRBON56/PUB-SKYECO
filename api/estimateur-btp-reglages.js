// /api/estimateur-btp-reglages.js
// Sauvegarde les réglages entreprise (nom, coordonnées, logo, TVA par défaut,
// lien dashboard) et les prix personnalisés (overrides) d'un compte
// Estimateur BTP, pour qu'ils soient identiques sur tous les appareils
// connectés avec le même email (25/09/2026).
//
// N'INCLUT PAS les champs propres au client du devis en cours (nom/téléphone/
// email/adresse du client) — ceux-là sont attachés à chaque devis via
// api/estimateur-btp-devis.js, pas au compte.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function emailValide(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const email = (req.body?.email || '').trim().toLowerCase();
  const { reglages, overrides } = req.body || {};
  if (!emailValide(email)) {
    return res.status(400).json({ success: false, error: 'Email invalide' });
  }

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_acces?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          reglages: reglages || null,
          overrides: overrides || null,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text);
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('estimateur-btp-reglages error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
}
