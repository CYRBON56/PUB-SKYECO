// /api/verify-test-bypass.js
// Autorise à sauter la vérification SMS du numéro de téléphone pendant
// l'inscription (skyeco-pro-formulaire-creation.html), pour tester tout le
// parcours plusieurs fois sans avoir à recevoir/taper un vrai code à chaque
// essai. Protégé par le même mot de passe interne que les autres pages
// d'admin — jamais accessible sans lui, quoi qu'il arrive côté client.
// N'envoie et ne vérifie aucun SMS : renvoie juste une autorisation.
//
// Variable d'environnement requise : INTERNAL_ACCESS_PASSWORD

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false });
  }
  const { motDePasseInterne } = req.body || {};
  if (!process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(500).json({ success: false, error: 'Mot de passe interne non configuré côté serveur.' });
  }
  if (motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }
  return res.status(200).json({ success: true });
}
