// /api/extraire-donnees-site.js
// Tentative d'extraction (best-effort, non garantie) de SIRET, RCS et capital
// social depuis la page "mentions légales" ou l'accueil d'un site existant.
// Ce n'est PAS fiable à 100% — l'artisan doit toujours vérifier les valeurs
// avant de les valider.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { url: urlBrute } = req.body || {};
  if (!urlBrute) {
    return res.status(400).json({ success: false, error: 'URL manquante' });
  }
  // Ajoute le protocole si l'utilisateur l'a omis (ex: "www.ecosky.fr" au lieu
  // de "https://www.ecosky.fr") — fetch() échoue silencieusement sans ça.
  const url = /^https?:\/\//i.test(urlBrute) ? urlBrute : `https://${urlBrute}`;

  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SkyecoProBot)' } });
    if (!resp.ok) {
      return res.status(200).json({ success: false, error: "Impossible d'accéder à cette page." });
    }
    const html = await resp.text();
    const texte = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    // SIRET : 14 chiffres, éventuellement espacés.
    const siretMatch = texte.match(/SIRET\s*:?\s*(\d{3}\s?\d{3}\s?\d{3}\s?\d{5})/i);
    const siret = siretMatch ? siretMatch[1].replace(/\s/g, '') : null;

    // RCS : "RCS <Ville>"
    const rcsMatch = texte.match(/RCS\s+([A-ZÀ-ÿ][a-zà-ÿ\-]+)/);
    const rcsVille = rcsMatch ? rcsMatch[1] : null;

    // Capital social : "capital de X €" ou "capital social de X €"
    const capitalMatch = texte.match(/capital(?:\s+social)?\s+de\s+([\d\s.,]+)\s*€/i);
    const capitalSocial = capitalMatch ? capitalMatch[1].trim() + ' €' : null;

    return res.status(200).json({
      success: true,
      siret,
      rcsVille,
      capitalSocial,
    });
  } catch (err) {
    console.error('Erreur extraire-donnees-site :', err);
    return res.status(200).json({ success: false, error: "Cette page n'a pas pu être analysée." });
  }
}
