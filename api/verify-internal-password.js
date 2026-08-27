// /api/verify-internal-password.js
// Vérifie le mot de passe d'accès à la page de prospection interne.
// Variable d'environnement requise : INTERNAL_ACCESS_PASSWORD

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false });
  }
  const { password } = req.body || {};
  if (!process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(500).json({ success: false, error: 'Mot de passe non configuré côté serveur.' });
  }
  if (password === process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(200).json({ success: true });
  }
  return res.status(401).json({ success: false, error: 'Mot de passe incorrect.' });
}
