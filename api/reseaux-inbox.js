// /api/reseaux-inbox.js
// Boîte « Réponses réseaux » de l'artisan (24/11/2026).
//   GET  ?id=<draftId>&token=<jeton dashboard>           -> liste des commentaires/messages
//   POST { id, token, action:'repondre', itemId, texte }  -> publie la réponse sur le réseau
//   POST { id, token, action:'ignorer', itemId }           -> marque comme traité sans répondre
// La réponse n'est JAMAIS publiée sans ce clic de l'artisan.

import { sbGet, sbPatch, verifierToken, publierReponse } from './_lib/reseaux-inbox.js';
import { repondreTikTok } from './tiktok-comments.js';

export default async function handler(req, res) {
  const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const draftId = src.id;
  if (!draftId || !verifierToken(src.token, draftId)) return res.status(401).json({ erreur: 'Session expirée, reconnectez-vous à votre espace.' });
  const d = encodeURIComponent(draftId);

  if (req.method === 'GET') {
    const items = await sbGet(`reseaux_inbox?draft_id=eq.${d}&order=recu_le.desc&limit=100&select=id,plateforme,type,nom_page,auteur,texte,reponse_proposee,reponse_envoyee,statut,recu_le,repondu_le,erreur`);
    const cnx = (await sbGet(`skyeco_pro_social_connections?draft_id=eq.${d}&select=facebook_page_name,ig_username,tiktok_username,inbox_abonne&limit=1`))[0] || null;
    return res.status(200).json({ items, connexion: cnx });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const itemId = parseInt(src.itemId, 10);
  const item = (await sbGet(`reseaux_inbox?id=eq.${itemId}&draft_id=eq.${d}&limit=1`))[0];
  if (!item) return res.status(404).json({ erreur: 'Élément introuvable' });

  if (src.action === 'ignorer') {
    await sbPatch('reseaux_inbox', `id=eq.${itemId}`, { statut: 'ignoré' });
    return res.status(200).json({ ok: true });
  }
  if (src.action !== 'repondre') return res.status(400).json({ erreur: 'Action inconnue' });

  const texte = String(src.texte || '').trim().slice(0, 2000);
  if (!texte) return res.status(400).json({ erreur: 'Réponse vide' });
  if (item.statut === 'répondu') return res.status(409).json({ erreur: 'Déjà répondu' });

  const cnx = (await sbGet(`skyeco_pro_social_connections?draft_id=eq.${d}&select=*&limit=1`))[0];
  if (!cnx) return res.status(400).json({ erreur: 'Reconnectez votre compte depuis votre espace.' });

  const r = item.plateforme === 'tiktok' ? await repondreTikTok(item, cnx, texte) : await publierReponse(item, cnx, texte);
  if (!r.ok) {
    await sbPatch('reseaux_inbox', `id=eq.${itemId}`, { erreur: r.erreur });
    return res.status(502).json({ erreur: r.erreur });
  }
  await sbPatch('reseaux_inbox', `id=eq.${itemId}`, { statut: 'répondu', reponse_envoyee: texte, repondu_le: new Date().toISOString(), erreur: null });
  return res.status(200).json({ ok: true });
}
