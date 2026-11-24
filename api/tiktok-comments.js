// /api/tiktok-comments.js
// Boîte « Réponses réseaux » — partie TikTok (24/11/2026, en construction).
//
// Ce que TikTok permet (API for Business, « TikTok Accounts / Organic API ») :
//   - lister les vidéos d'un compte TikTok BUSINESS et leurs commentaires ;
//   - répondre à un commentaire de 1er niveau.
// Ce que TikTok ne permet PAS par API pour un compte ordinaire : lire ou
// envoyer les messages privés (Business Messaging API réservée à des
// partenaires), recevoir un webhook en temps réel -> on interroge toutes les
// heures (cron).
//
// Points de blocage à lever (côté Cyrille, dans business-api.tiktok.com) :
//   1. Le compte TikTok doit être passé en « compte Business » (gratuit, dans l'appli TikTok).
//   2. Créer une app développeur « TikTok API for Business », demander l'accès
//      aux API « TikTok Accounts » avec les droits de liste et de gestion des
//      commentaires, et attendre la validation de TikTok.
//   3. Renseigner TIKTOK_BIZ_APP_ID / TIKTOK_BIZ_SECRET, puis connecter le compte :
//      le jeton (access_token) et le business_id sont stockés dans
//      skyeco_pro_social_connections (tiktok_biz_token, tiktok_business_id).
// Les chemins ci-dessous suivent la doc publique « /business/... » v1.3 ; à
// revérifier dans la doc TikTok au moment de l'activation.
//
//   GET  ?cron=1  (Vercel cron, en-tête Authorization: Bearer CRON_SECRET) -> synchronise tous les comptes
//   POST { itemId, texte } est géré par api/reseaux-inbox.js via repondreTikTok()

import { sbGet, sbInsert, sbPatch, proposerReponse } from './_lib/reseaux-inbox.js';

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';

async function tt(chemin, jeton, params = {}, methode = 'GET') {
  const url = new URL(BASE + chemin);
  const init = { method: methode, headers: { 'Access-Token': jeton, 'Content-Type': 'application/json' } };
  if (methode === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  else init.body = JSON.stringify(params);
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(`TikTok ${chemin} : ${j.message || r.status}`);
  return j.data || {};
}

export async function repondreTikTok(item, cnx, texte) {
  try {
    const d = await tt('/business/comment/reply/create/', cnx.tiktok_biz_token, {
      business_id: cnx.tiktok_business_id, video_id: item.publication_id, comment_id: item.objet_id, text: texte,
    }, 'POST');
    return { ok: true, id: d.comment_id || null };
  } catch (e) {
    return { ok: false, erreur: e.message };
  }
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const comptes = await sbGet('skyeco_pro_social_connections?tiktok_biz_token=not.is.null&select=draft_id,tiktok_business_id,tiktok_biz_token,tiktok_username');
  const bilan = [];
  for (const c of comptes) {
    try {
      const v = await tt('/business/video/list/', c.tiktok_biz_token, { business_id: c.tiktok_business_id, fields: ['item_id', 'create_time'], max_count: 10 });
      let nouveaux = 0;
      for (const video of v.videos || []) {
        const cm = await tt('/business/comment/list/', c.tiktok_biz_token, { business_id: c.tiktok_business_id, video_id: video.item_id, max_count: 30 });
        for (const k of cm.comments || []) {
          if (k.owner) continue; // nos propres réponses
          const lignes = await sbInsert('reseaux_inbox', [{
            draft_id: c.draft_id, compte_id: c.tiktok_business_id, nom_page: c.tiktok_username ? '@' + c.tiktok_username : 'TikTok',
            plateforme: 'tiktok', type: 'commentaire', objet_id: k.comment_id, publication_id: video.item_id,
            auteur_id: k.user_id || null, auteur: k.username || k.display_name || null, texte: k.text || '',
            recu_le: k.create_time ? new Date(k.create_time * 1000).toISOString() : new Date().toISOString(), statut: 'à répondre',
          }], 'plateforme,objet_id');
          if (!lignes[0]) continue;
          nouveaux++;
          const p = await proposerReponse({ texte: k.text, auteur: k.username, plateforme: 'TikTok', type: 'commentaire', nomPage: lignes[0].nom_page });
          if (p) await sbPatch('reseaux_inbox', `id=eq.${lignes[0].id}`, /^\(ne pas répondre\)$/i.test(p) ? { statut: 'ignoré (spam)' } : { reponse_proposee: p });
        }
      }
      bilan.push({ draft: c.draft_id, nouveaux });
    } catch (e) {
      bilan.push({ draft: c.draft_id, erreur: e.message });
    }
  }
  return res.status(200).json({ comptes: comptes.length, bilan });
}
