// /api/meteo-demo.js
// 09/10/2026 — Prévisions pour les démos des 3 applis d'hiver
// (meteo-chantier, stock-granules, facture-chauffage).
// Source : MET Norway Locationforecast 2.0 (licence CC BY 4.0, usage commercial
// autorisé avec mention de la source ; User-Agent identifiant obligatoire).
// Entrée : ?lat=..&lon=..  Sortie : { source, points:[{t, T, rh, dew, pr, h}] }
//   t = heure ISO UTC, T = °C, rh = %, dew = point de rosée °C,
//   pr = pluie (mm) sur le pas de temps, h = durée du pas (1 ou 6 heures).
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

export default async function handler(req, res) {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  // France métropolitaine et Corse uniquement (la démo ne sert qu'à ça)
  if (!(lat > 41 && lat < 51.5 && lon > -5.5 && lon < 10)) return res.status(400).json({ error: 'Commune hors de France métropolitaine.' });
  if (!(await verifierLimite('meteo-demo:' + ipDepuisRequete(req), 60, 600))) return res.status(429).json({ error: 'Trop de demandes, réessayez dans quelques minutes.' });
  // 2 décimales max : exigé par MET Norway (et améliore le cache)
  const la = lat.toFixed(2), lo = lon.toFixed(2);
  try {
    const r = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${la}&lon=${lo}`, {
      headers: { 'User-Agent': 'MeteoChantier-demo/0.1 (skyeco.fr; infos@ecosky.fr)' },
    });
    if (!r.ok) throw new Error('MET Norway ' + r.status);
    const j = await r.json();
    const points = [];
    for (const ts of j.properties?.timeseries || []) {
      const d = ts.data?.instant?.details || {};
      const n1 = ts.data?.next_1_hours, n6 = ts.data?.next_6_hours;
      const h = n1 ? 1 : n6 ? 6 : 0;
      if (!h || typeof d.air_temperature !== 'number') continue;
      points.push({
        t: ts.time,
        T: d.air_temperature,
        rh: d.relative_humidity ?? null,
        dew: d.dew_point_temperature ?? null,
        pr: (n1 || n6).details?.precipitation_amount ?? 0,
        h,
      });
    }
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ source: 'MET Norway (CC BY 4.0)', points });
  } catch (e) {
    console.error('meteo-demo :', e.message);
    return res.status(502).json({ error: 'Prévisions indisponibles pour le moment. Réessayez dans un instant.' });
  }
}
