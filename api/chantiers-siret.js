// /api/chantiers-siret.js : pré-remplit l'inscription artisan à partir du SIRET
import { ficheSiret } from './_lib/sirene.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';
export default async function handler(req, res) {
  if (!(await verifierLimite('ch-siret:' + ipDepuisRequete(req), 30, 600))) return res.status(429).json({ error: 'Trop de recherches, patientez quelques minutes.' });
  try {
    const f = await ficheSiret(req.query.siret);
    if (!f) return res.status(404).json({ error: 'SIRET introuvable dans la base officielle.' });
    if (!f.actif) return res.status(400).json({ error: "Cet établissement n'est pas actif selon la base officielle." });
    return res.status(200).json(f);
  } catch { return res.status(502).json({ error: 'Base officielle indisponible, réessayez dans un instant.' }); }
}
