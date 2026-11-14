// /api/documents.js — Mon Assistant Pro : rangement automatique des documents
// dans le Dropbox de l'artisan (14/11/2026, premier test sur RMS).
//
//   GET  ?action=connecter&compte=rms   → envoie vers Dropbox pour autoriser l'accès
//   GET  ?action=retour&code=…&state=…  → retour de Dropbox, enregistre la connexion
//   GET  ?action=etat&compte=rms        → connecté ou non (sans aucun secret)
//   POST ?action=ranger                 → dépose un fichier et l'inscrit au journal
//        en-tête Authorization: Bearer <clé de rangement du compte>
//        corps JSON { compte, chemin:"/03 RMS - Clients & devis/Le Gall – Vannes/Devis",
//                     nom:"2026-11-14_Devis-D2026-109_Le-Gall.pdf", contenu_base64, source }
//
// Sécurité :
// - une première connexion est libre ; REMPLACER une connexion existante
//   exige la clé de rangement du compte (sinon n'importe qui pourrait
//   brancher son propre Dropbox à la place de celui de l'artisan) ;
// - le "state" OAuth est signé (HMAC, 10 min) pour qu'on ne puisse pas
//   rattacher un Dropbox à un autre compte que celui demandé ;
// - la clé de rangement est créée à la connexion, stockée côté serveur
//   (Supabase, accès service uniquement) et jamais affichée dans une page ;
// - rien n'est jamais supprimé ni écrasé dans le Dropbox (mode "add").
//
// Variables d'environnement : DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

const REDIRECT = 'https://www.skyeco.fr/api/dropbox-callback';
const SB = () => process.env.SUPABASE_URL;
const SBH = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});

async function sb(path, opts = {}) {
  const r = await fetch(`${SB()}/rest/v1/${path}`, { ...opts, headers: { ...SBH(), ...(opts.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

function signer(payload) {
  return crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
}
function creerEtat(compte) {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const p = `${compte}.${exp}`;
  return Buffer.from(`${p}.${signer(p)}`).toString('base64url');
}
function lireEtat(state) {
  try {
    const [compte, exp, sig] = Buffer.from(String(state), 'base64url').toString().split('.');
    if (!compte || !exp || Date.now() / 1000 > +exp) return null;
    const ok = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signer(`${compte}.${exp}`), 'hex'));
    return ok ? compte : null;
  } catch { return null; }
}
const compteValide = (c) => /^[a-z0-9_-]{2,40}$/.test(String(c || ''));
const page = (res, titre, texte) => res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titre}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#14304A">
<h1 style="font-size:24px">${titre}</h1><p style="font-size:17px;line-height:1.5">${texte}</p>
<p><a href="/mon-assistant-pro/inscription/" style="color:#E8622C;font-weight:700">Retour à Mon Assistant Pro</a></p></body>`);

async function connexion(compte) {
  const r = await sb(`connexions_stockage?compte=eq.${encodeURIComponent(compte)}&select=*`);
  return r && r[0] ? r[0] : null;
}

async function jetonDropbox(refresh) {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refresh,
      client_id: process.env.DROPBOX_APP_KEY, client_secret: process.env.DROPBOX_APP_SECRET,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Dropbox refuse le jeton : ' + (j.error_description || r.status));
  return j.access_token;
}

export default async function handler(req, res) {
  const action = String(req.query.action || (req.url.includes('dropbox-callback') ? 'retour' : ''));
  try {
    if (!process.env.DROPBOX_APP_KEY || !process.env.DROPBOX_APP_SECRET) {
      return page(res, 'Pas encore prêt', "L'accès Dropbox de l'appli n'est pas encore configuré (clés DROPBOX_APP_KEY et DROPBOX_APP_SECRET manquantes dans Vercel).");
    }

    if (action === 'etat') {
      const c = String(req.query.compte || '');
      if (!compteValide(c)) return res.status(400).json({ erreur: 'compte invalide' });
      const x = await connexion(c);
      return res.status(200).json({ connecte: !!x, fournisseur: x?.fournisseur || null, compte_email: x?.compte_email || null });
    }

    if (action === 'connecter') {
      const c = String(req.query.compte || '');
      if (!compteValide(c)) return page(res, 'Lien invalide', 'Ce lien de connexion est incomplet.');
      const deja = await connexion(c);
      if (deja) {
        const cle = String(req.query.cle || '');
        const attendue = deja.racine || '';
        if (!cle || !attendue || cle.length !== attendue.length || !crypto.timingSafeEqual(Buffer.from(cle), Buffer.from(attendue))) {
          return page(res, 'Déjà connecté', `Un Dropbox est déjà relié à ce compte (${deja.compte_email || 'compte Dropbox'}). Pour le remplacer, demandez à Skyeco.`);
        }
      }
      const u = new URL('https://www.dropbox.com/oauth2/authorize');
      u.searchParams.set('client_id', process.env.DROPBOX_APP_KEY);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('token_access_type', 'offline');
      u.searchParams.set('redirect_uri', REDIRECT);
      u.searchParams.set('state', creerEtat(c));
      res.setHeader('Location', u.toString());
      return res.status(302).end();
    }

    if (action === 'retour') {
      const compte = lireEtat(req.query.state);
      if (!compte) return page(res, 'Lien expiré', 'La connexion a pris trop de temps ou le lien est invalide. Recommencez depuis Mon Assistant Pro.');
      if (req.query.error) return page(res, 'Connexion annulée', "Vous n'avez pas autorisé l'accès à Dropbox. Rien n'a été modifié.");
      const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code || ''), grant_type: 'authorization_code', redirect_uri: REDIRECT,
          client_id: process.env.DROPBOX_APP_KEY, client_secret: process.env.DROPBOX_APP_SECRET,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.refresh_token) return page(res, 'Connexion impossible', 'Dropbox a refusé la connexion. Réessayez dans un instant.');
      let email = null;
      try {
        const a = await fetch('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { Authorization: `Bearer ${j.access_token}` } });
        if (a.ok) email = (await a.json()).email || null;
      } catch {}
      const ancienne = await connexion(compte);
      const cle = ancienne?.racine || crypto.randomBytes(24).toString('base64url');
      await sb('connexions_stockage', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ compte, fournisseur: 'Dropbox', refresh_token: j.refresh_token, compte_email: email, racine: cle, updated_at: new Date().toISOString() }),
      });
      return page(res, 'Dropbox connecté ✅', `Votre Dropbox${email ? ' (' + email + ')' : ''} est relié à Mon Assistant Pro. Vos devis, factures et documents y seront rangés automatiquement, et chaque rangement sera noté dans le journal.`);
    }

    if (action === 'ranger' && req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      if (!compteValide(b.compte)) return res.status(400).json({ erreur: 'compte invalide' });
      const x = await connexion(b.compte);
      if (!x) return res.status(404).json({ erreur: 'aucun Dropbox connecté pour ce compte' });
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!auth || auth.length !== (x.racine || '').length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(x.racine))) {
        return res.status(401).json({ erreur: 'clé de rangement invalide' });
      }
      const chemin = String(b.chemin || '/00 À trier').normalize('NFC');
      const nom = String(b.nom || '').normalize('NFC');
      if (!chemin.startsWith('/') || chemin.includes('..') || chemin.includes('\\') || !nom || /[\\/]/.test(nom) || nom.length > 180) {
        return res.status(400).json({ erreur: 'chemin ou nom de fichier invalide' });
      }
      const contenu = Buffer.from(String(b.contenu_base64 || ''), 'base64');
      if (!contenu.length || contenu.length > 3.2e6) return res.status(400).json({ erreur: 'fichier vide ou trop gros' });
      const jeton = await jetonDropbox(x.refresh_token);
      const arg = JSON.stringify({ path: `${chemin.replace(/\/+$/, '')}/${nom}`, mode: 'add', autorename: true, mute: false })
        .replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      const up = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': arg },
        body: contenu,
      });
      const u = await up.json().catch(() => ({}));
      if (!up.ok) return res.status(502).json({ erreur: 'Dropbox a refusé le fichier', detail: u.error_summary || up.status });
      await sb('journal_rangement', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ compte: b.compte, document: nom, source: String(b.source || '').slice(0, 200) || null, chemin: u.path_display || `${chemin}/${nom}`, taille: contenu.length }),
      });
      return res.status(200).json({ ok: true, chemin: u.path_display });
    }

    return res.status(400).json({ erreur: 'action inconnue' });
  } catch (e) {
    console.error('documents:', e.message);
    return res.status(500).json({ erreur: 'erreur serveur' });
  }
}
