// Outil interne : renvoie en base64 une image générée sur Gamma (cdn.gamma.app uniquement).
// Sert à récupérer les visuels des vidéos démo depuis l'atelier de montage.
export default async function handler(req, res) {
  try {
    const u = new URL(String(req.query.u || ''));
    if (u.protocol !== 'https:' || u.hostname !== 'cdn.gamma.app') return res.status(400).send('hote refuse');
    const r = await fetch(u);
    if (!r.ok) return res.status(502).send('erreur ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8e6) return res.status(413).send('trop gros');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf.toString('base64'));
  } catch (e) { return res.status(400).send('url invalide'); }
}
