// /api/meta-webhook.js
// Webhook Meta (24/11/2026) : reçoit en temps réel les commentaires et les
// messages privés des Pages Facebook et des comptes Instagram pro connectés,
// les range dans la table reseaux_inbox avec une réponse proposée par l'IA.
// Rien n'est publié ici : l'artisan valide la réponse depuis
// /reponses-reseaux.html (api/reseaux-inbox.js).
//
// À déclarer dans developers.facebook.com > app > Webhooks :
//   URL de rappel : https://www.skyeco.fr/api/meta-webhook
//   Jeton de vérification : valeur de META_WEBHOOK_VERIFY_TOKEN (définie sur Vercel le 24/11/2026)
//   Objet « Page » : champs feed, messages
//   Objet « Instagram » : champs comments, messages
//
// Variables d'environnement : META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

import crypto from 'crypto';
import { sbGet, sbInsert, sbPatch, proposerReponse } from './_lib/reseaux-inbox.js';

export const config = { api: { bodyParser: false } };

async function lireCorpsBrut(req) {
  const morceaux = [];
  for await (const m of req) morceaux.push(typeof m === 'string' ? Buffer.from(m) : m);
  return Buffer.concat(morceaux);
}

function signatureValide(brut, entete) {
  if (!process.env.META_APP_SECRET || !entete) return false;
  const attendu = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(brut).digest('hex');
  const a = Buffer.from(entete), b = Buffer.from(attendu);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function connexionPour(idCompte) {
  const id = encodeURIComponent(idCompte);
  const r = await sbGet(`skyeco_pro_social_connections?or=(facebook_page_id.eq.${id},ig_business_account_id.eq.${id})&select=draft_id,facebook_page_id,facebook_page_name,ig_business_account_id,ig_username&limit=1`);
  return r[0] || null;
}

function extraire(objet, entree) {
  const res = [];
  // Commentaires (Page : champ feed ; Instagram : champ comments)
  for (const ch of entree.changes || []) {
    const v = ch.value || {};
    if (objet === 'page' && ch.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
      if (v.from && v.from.id === entree.id) continue; // notre propre réponse
      res.push({
        plateforme: 'facebook', type: 'commentaire', objet_id: v.comment_id, publication_id: v.post_id,
        auteur_id: v.from?.id || null, auteur: v.from?.name || null, texte: v.message || '',
        recu_le: v.created_time ? new Date(v.created_time * 1000).toISOString() : new Date().toISOString(),
      });
    }
    if (objet === 'instagram' && ch.field === 'comments') {
      if (v.from && v.from.id === entree.id) continue;
      res.push({
        plateforme: 'instagram', type: 'commentaire', objet_id: v.id, publication_id: v.media?.id || null,
        auteur_id: v.from?.id || null, auteur: v.from?.username || null, texte: v.text || '',
        recu_le: new Date().toISOString(),
      });
    }
  }
  // Messages privés (Messenger ou Instagram Direct)
  for (const m of entree.messaging || []) {
    if (!m.message || m.message.is_echo || !m.message.text) continue;
    res.push({
      plateforme: objet === 'instagram' ? 'instagram' : 'facebook', type: 'message', objet_id: m.message.mid,
      publication_id: null, auteur_id: m.sender?.id || null, auteur: null, texte: m.message.text,
      recu_le: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
    });
  }
  return res;
}

export default async function handler(req, res) {
  // 1. Vérification de l'abonnement par Meta
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('Refusé');
  }
  if (req.method !== 'POST') return res.status(405).end();

  const brut = await lireCorpsBrut(req);
  if (!signatureValide(brut, req.headers['x-hub-signature-256'])) return res.status(401).send('Signature invalide');

  let corps;
  try { corps = JSON.parse(brut.toString('utf8')); } catch (_) { return res.status(400).end(); }
  const objet = corps.object; // 'page' ou 'instagram'

  try {
    for (const entree of corps.entry || []) {
      const items = extraire(objet, entree);
      if (!items.length) continue;
      const cnx = await connexionPour(entree.id);
      for (const it of items) {
        const lignes = await sbInsert('reseaux_inbox', [{
          ...it,
          compte_id: entree.id,
          draft_id: cnx?.draft_id || null,
          nom_page: cnx ? (it.plateforme === 'instagram' ? (cnx.ig_username ? '@' + cnx.ig_username : cnx.facebook_page_name) : cnx.facebook_page_name) : null,
          statut: 'à répondre',
        }], 'plateforme,objet_id');
        const ligne = lignes[0];
        if (!ligne) continue; // déjà reçu (Meta renvoie parfois deux fois)
        const proposition = await proposerReponse({ texte: it.texte, auteur: it.auteur, plateforme: it.plateforme === 'instagram' ? 'Instagram' : 'Facebook', type: it.type, nomPage: ligne.nom_page });
        if (proposition) {
          const ignorer = /^\(ne pas répondre\)$/i.test(proposition);
          await sbPatch('reseaux_inbox', `id=eq.${ligne.id}`, ignorer ? { reponse_proposee: null, statut: 'ignoré (spam)' } : { reponse_proposee: proposition });
        }
      }
    }
  } catch (e) {
    console.error('meta-webhook :', e);
  }
  // Toujours 200 : sinon Meta désactive le webhook après plusieurs échecs.
  return res.status(200).send('EVENT_RECEIVED');
}
