// /api/campagne-chantiers-suivi.js : suivi de l'emailing artisans.
// ?t=<jeton>&a=ouv  -> pixel d'ouverture ; a=clic -> redirection vers chantiers.html ; a=stop -> désinscription.
import { sb } from './_lib/prix-travaux-commande.js';
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const ROBOT = /bot|crawler|spider|preview|scan|proofpoint|mimecast|barracuda|safelinks|googleimageproxy/i;
export default async function handler(req, res) {
  const t = String(req.query.t || ''), a = String(req.query.a || '');
  const valide = /^[0-9a-f]{32}$/.test(t);
  let ligne = null;
  try { if (valide) [ligne] = await sb(`campagne_chantiers?token=eq.${t}&select=id,prospect_id,ouvert_le,nb_ouvertures,clique_le,nb_clics`); } catch {}
  const maintenant = new Date().toISOString(), robot = ROBOT.test(req.headers['user-agent'] || '');
  if (a === 'ouv') {
    if (ligne && !robot) await sb(`campagne_chantiers?id=eq.${ligne.id}`, { method: 'PATCH', body: JSON.stringify({ ouvert_le: ligne.ouvert_le || maintenant, nb_ouvertures: ligne.nb_ouvertures + 1 }) }).catch(() => {});
    res.setHeader('Content-Type', 'image/gif'); res.setHeader('Cache-Control', 'no-store'); return res.status(200).send(GIF);
  }
  if (a === 'stop') {
    if (ligne) {
      await sb(`campagne_chantiers?id=eq.${ligne.id}`, { method: 'PATCH', body: JSON.stringify({ statut: 'desabonne' }) }).catch(() => {});
      await sb(`prospects_paysagiste?id=eq.${ligne.prospect_id}`, { method: 'PATCH', body: JSON.stringify({ opt_out: true, opt_out_date: maintenant }) }).catch(() => {});
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Désinscription</title></head><body style="font-family:Arial,sans-serif;background:#F4F7F9;color:#14304A;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:420px;text-align:center;padding:24px"><h1 style="font-size:1.4rem">${ligne ? 'Vous êtes désinscrit' : 'Lien invalide'}</h1><p>${ligne ? 'Vous ne recevrez plus de messages de Skyeco.' : "Ce lien n'est pas valide."}</p></div></body></html>`);
  }
  if (ligne && !robot) await sb(`campagne_chantiers?id=eq.${ligne.id}`, { method: 'PATCH', body: JSON.stringify({ clique_le: ligne.clique_le || maintenant, nb_clics: ligne.nb_clics + 1, ...(ligne.ouvert_le ? {} : { ouvert_le: maintenant }) }) }).catch(() => {});
  res.setHeader('Location', 'https://www.skyeco.fr/chantiers.html?src=email'); return res.status(302).end();
}
