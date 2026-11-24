// /api/_lib/reseaux-inbox.js
// Outils partagés de la boîte « Réponses réseaux » (24/11/2026) :
// lecture/écriture Supabase, proposition de réponse par l'IA, vérification
// du jeton de session du dashboard, envoi d'une réponse sur Facebook /
// Instagram / Messenger via la Graph API.

import crypto from 'crypto';

const GRAPH = 'https://graph.facebook.com/v21.0';

export function sbHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function sbGet(chemin) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${chemin}`, { headers: sbHeaders() });
  return r.ok ? r.json() : [];
}

export async function sbInsert(table, lignes, upsertSur) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}${upsertSur ? `?on_conflict=${upsertSur}` : ''}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: sbHeaders({ Prefer: `${upsertSur ? 'resolution=ignore-duplicates,' : ''}return=representation` }),
    body: JSON.stringify(lignes),
  });
  return r.ok ? r.json() : [];
}

export async function sbPatch(table, filtre, champs) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${filtre}`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(champs),
  });
}

// Même schéma de jeton que le dashboard (base64url "sujet.role.exp.sig").
export function verifierToken(token, draftIdAttendu) {
  try {
    const [sujet, role, expStr, sig] = Buffer.from(String(token || ''), 'base64url').toString('utf8').split('.');
    const exp = parseInt(expStr, 10);
    if (!sig || !exp || Date.now() / 1000 > exp) return false;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(`${sujet}.${role}.${expStr}`).digest('hex');
    const a = Buffer.from(sig, 'hex'), b = Buffer.from(attendu, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return role === 'admin' ? sujet === draftIdAttendu : role === 'artisan';
  } catch (_) {
    return false;
  }
}

// Proposition de réponse : courte, polie, constructive, jamais de prix inventé.
export async function proposerReponse({ texte, auteur, plateforme, type, nomPage }) {
  if (!process.env.ANTHROPIC_API_KEY || !texte) return null;
  const consigne = `Tu rédiges la réponse d'une petite entreprise du bâtiment (page « ${nomPage || 'notre entreprise'} ») à ${type === 'message' ? 'un message privé' : 'un commentaire public'} reçu sur ${plateforme}.
Règles : français, vouvoiement, 1 à 3 phrases, ton chaleureux et professionnel, jamais sur la défensive.
N'invente AUCUN prix, délai, garantie, promo ou caractéristique produit. Ne dis jamais « sur mesure ».
Si c'est une critique (ex. « trop cher ») : remercie, demande à quoi la personne compare ou rappelle qu'aucun devis n'a encore été fait, et propose un chiffrage gratuit et sans engagement.
Si c'est une question : réponds simplement si c'est évident, sinon invite à envoyer un message privé ou à demander un devis.
Si c'est un compliment : remercie sincèrement.
Si c'est du spam ou une insulte : réponds exactement « (ne pas répondre) ».
Ne mets ni guillemets ni signature. Réponds uniquement par le texte de la réponse.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: consigne,
        messages: [{ role: 'user', content: `${auteur ? auteur + ' a écrit' : 'Texte reçu'} : ${texte}` }],
      }),
    });
    const j = await r.json();
    return (j.content || []).map((c) => c.text || '').join('').trim() || null;
  } catch (_) {
    return null;
  }
}

// Envoie la réponse sur le bon réseau. Retourne { ok, id, erreur }.
export async function publierReponse(item, connexion, texte) {
  const jetonPage = connexion.facebook_access_token || connexion.access_token;
  if (!jetonPage) return { ok: false, erreur: 'Page non connectée' };
  let url, corps;
  if (item.plateforme === 'facebook' && item.type === 'commentaire') {
    url = `${GRAPH}/${item.objet_id}/comments`;
    corps = { message: texte };
  } else if (item.plateforme === 'instagram' && item.type === 'commentaire') {
    url = `${GRAPH}/${item.objet_id}/replies`;
    corps = { message: texte };
  } else if (item.type === 'message') {
    // Messenger et messages privés Instagram passent par la Page.
    url = `${GRAPH}/${connexion.facebook_page_id}/messages`;
    corps = { recipient: { id: item.auteur_id }, messaging_type: 'RESPONSE', message: { text: texte } };
  } else {
    return { ok: false, erreur: 'Type non pris en charge' };
  }
  const r = await fetch(`${url}?access_token=${encodeURIComponent(jetonPage)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corps),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return { ok: false, erreur: (j.error && j.error.message) || `HTTP ${r.status}` };
  return { ok: true, id: j.id || j.message_id || null };
}
