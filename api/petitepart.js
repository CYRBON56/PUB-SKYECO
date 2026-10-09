// /api/petitepart.js
// 09/10/2026 — Backend de l'appli « Petite Part » (skyeco.fr/petitepart).
// Une seule fonction, plusieurs actions (?action=...) :
//   essai     POST {email}          -> session Stripe Checkout (abonnement 4,99 €/mois, 7 jours offerts)
//   activer   POST {session_id}     -> vérifie la session Stripe, crée l'abonné et renvoie un jeton d'accès
//   lien      POST {email}          -> envoie par email un lien de connexion (nouvel appareil)
//   jeton     POST {jeton_email}    -> échange le lien reçu par email contre un jeton d'accès
//   statut    POST {jeton}          -> état de l'abonnement
//   ia        POST {jeton, type, …} -> appelle Claude (photo d'assiette, recette, coach) pour un abonné actif
//   resilier  POST {jeton}          -> résiliation à la fin de la période en cours
// Les photos d'assiette sont envoyées à Claude pour l'analyse et ne sont
// jamais stockées ici. Les photos du corps ne quittent jamais le téléphone.
// Variables : ANTHROPIC_API_KEY, STRIPE_SECRET_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY.
import Stripe from 'stripe';
import crypto from 'node:crypto';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PRIX_CENTIMES = 499;
const JOURS_ESSAI = 7;
const QUOTA_JOUR = 25; // appels à Claude par abonné payant et par jour (maîtrise des coûts)
const QUOTA_ESSAI = 10; // pendant l'essai gratuit sans carte
const MODELE = 'claude-sonnet-5-5';

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

const H = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' });
async function sb(path, opts = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...H(), Prefer: 'return=representation', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`supabase ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const emailOk = (e) => typeof e === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(e.trim());
const actif = (s) => s === 'trialing' || s === 'active';
const origine = (req) => req.headers.origin && /^https:\/\/(www\.)?skyeco\.fr$|^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(req.headers.origin) ? req.headers.origin : 'https://www.skyeco.fr';

async function nouveauJeton(abonneId) {
  const t = crypto.randomBytes(32).toString('base64url');
  await sb('petitepart_jetons', { method: 'POST', body: JSON.stringify({ token_hash: hash(t), abonne_id: abonneId }) });
  return t;
}
async function abonneDuJeton(jeton) {
  if (typeof jeton !== 'string' || jeton.length < 20) return null;
  const rows = await sb(`petitepart_jetons?token_hash=eq.${hash(jeton)}&select=abonne_id,petitepart_abonnes(*)`);
  const a = rows?.[0]?.petitepart_abonnes;
  if (!a) return null;
  // Si l'état n'a pas été rafraîchi depuis 6 h, on le revérifie chez Stripe.
  if (a.stripe_subscription && Date.now() - Date.parse(a.updated_at) > 6 * 3600e3) {
    try { const s = await stripe.subscriptions.retrieve(a.stripe_subscription); await majAbonne(a.id, s); a.statut = s.status; a.fin_periode = new Date(s.current_period_end * 1000).toISOString(); } catch {}
  }
  return a;
}
async function majAbonne(id, s) {
  await sb(`petitepart_abonnes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ statut: s.status, fin_periode: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null, updated_at: new Date().toISOString() }) });
}
async function upsertAbonne(email, customer, sub) {
  const rows = await sb('petitepart_abonnes?on_conflict=email', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ email, stripe_customer: customer, stripe_subscription: sub.id, statut: sub.status, fin_periode: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null, updated_at: new Date().toISOString() }) });
  return rows[0];
}
const essaiEnCours = (a) => a.statut === 'essai' && a.fin_periode && Date.parse(a.fin_periode) > Date.now();
const acces = (a) => actif(a.statut) || essaiEnCours(a);
function etat(a) {
  const jours = a.fin_periode ? Math.max(0, Math.ceil((Date.parse(a.fin_periode) - Date.now()) / 864e5)) : 0;
  return { email: a.email, statut: a.statut, actif: acces(a), essai: a.statut === 'essai', essai_fini: a.statut === 'essai' && !essaiEnCours(a), jours_restants: jours, fin_periode: a.fin_periode, abonne: actif(a.statut) };
}
async function emailBienvenue(email, url) {
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Petite Part <notifications@ecoskybyrms.fr>', to: [email], subject: 'Votre essai Petite Part : 7 jours offerts',
      html: `<p>Bonjour,</p><p>Votre essai gratuit de Petite Part est activé pour 7 jours, sans carte bancaire : photographiez vos assiettes, demandez des recettes et parlez à votre coach.</p><p>Pour retrouver l'appli sur un autre téléphone, touchez ce bouton :</p><p><a href="${url}" style="background:#2F7D4F;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Ouvrir Petite Part</a></p><p>À la fin de l'essai, rien n'est prélevé : vous choisirez si vous voulez continuer pour 4,99 € par mois.</p>` }) }).catch(() => {});
}

async function claude(content, maxTokens, system, modele = MODELE) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modele, max_tokens: maxTokens, ...(system ? { system } : {}), messages: content }),
  });
  const j = await r.json().catch(() => ({}));
  // Modèle indisponible sur le compte : on retombe sur celui déjà utilisé ailleurs sur le site.
  if (!r.ok && modele !== 'claude-sonnet-4-6' && (r.status === 404 || /model/i.test(JSON.stringify(j)))) return claude(content, maxTokens, system, 'claude-sonnet-4-6');
  if (!r.ok) throw new Error(`anthropic ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const action = String(req.query.action || '');
  const b = req.body || {};
  const ip = ipDepuisRequete(req);
  try {
    if (action === 'essai') {
      // Essai gratuit de 7 jours SANS carte bancaire. Une seule fois par adresse email.
      if (!(await verifierLimite('pp-essai:' + ip, 4, 3600))) return res.status(429).json({ error: 'Trop de tentatives. Réessayez plus tard.' });
      if (!emailOk(b.email)) return res.status(400).json({ error: 'Adresse email invalide.' });
      const email = b.email.trim().toLowerCase();
      const deja = await sb(`petitepart_abonnes?email=eq.${encodeURIComponent(email)}&select=id,statut`);
      if (deja?.[0]) return res.status(409).json({ error: "Cette adresse a déjà profité de l'essai. Touchez « Déjà inscrit ? » pour recevoir votre lien de connexion." });
      const [a] = await sb('petitepart_abonnes', { method: 'POST', body: JSON.stringify({ email, statut: 'essai', fin_periode: new Date(Date.now() + JOURS_ESSAI * 864e5).toISOString() }) });
      const jeton = await nouveauJeton(a.id);
      const t2 = await nouveauJeton(a.id);
      await emailBienvenue(email, `${origine(req)}/petitepart/?connexion=${t2}`);
      console.log('petitepart essai', email.replace(/^(.).*@/, '$1***@'));
      return res.status(200).json({ jeton, ...etat(a) });
    }

    if (action === 'abonner') {
      // Passage à l'offre payante (après ou pendant l'essai) : 4,99 €/mois, sans nouvel essai.
      if (!(await verifierLimite('pp-abo:' + ip, 8, 600))) return res.status(429).json({ error: 'Trop de tentatives.' });
      const a = await abonneDuJeton(b.jeton);
      if (!a) return res.status(401).json({ error: 'Connexion expirée. Demandez un lien de connexion.' });
      if (actif(a.statut)) return res.status(409).json({ error: 'Votre abonnement est déjà actif.' });
      const o = origine(req);
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription', locale: 'fr', customer_email: a.email,
        line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: PRIX_CENTIMES, recurring: { interval: 'month' }, product_data: { name: 'Petite Part — abonnement', description: 'Analyse de vos assiettes en photo, recettes sur mesure et coach. Résiliable à tout moment. TVA 20 % incluse.' } } }],
        subscription_data: { metadata: { product: 'petitepart' } },
        metadata: { product: 'petitepart' },
        success_url: `${o}/petitepart/?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${o}/petitepart/?annule=1`,
      });
      console.log('petitepart abonner', session.id);
      return res.status(200).json({ url: session.url });
    }

    if (action === 'activer') {
      if (!(await verifierLimite('pp-act:' + ip, 20, 600))) return res.status(429).json({ error: 'Trop de tentatives.' });
      if (typeof b.session_id !== 'string' || !b.session_id.startsWith('cs_')) return res.status(400).json({ error: 'Session invalide.' });
      const s = await stripe.checkout.sessions.retrieve(b.session_id, { expand: ['subscription'] });
      if (s.metadata?.product !== 'petitepart' || s.status !== 'complete' || !s.subscription) return res.status(400).json({ error: "Le paiement n'est pas confirmé." });
      const email = (s.customer_details?.email || s.customer_email || '').toLowerCase();
      const a = await upsertAbonne(email, s.customer, s.subscription);
      // Une session ne délivre qu'un nombre limité de jetons (protection si le lien circule).
      if (!(await verifierLimite('pp-act-s:' + b.session_id, 3, 86400))) return res.status(429).json({ error: 'Lien déjà utilisé. Demandez un lien de connexion par email.' });
      return res.status(200).json({ jeton: await nouveauJeton(a.id), ...etat(a) });
    }

    if (action === 'lien') {
      if (!(await verifierLimite('pp-lien:' + ip, 5, 900))) return res.status(429).json({ error: 'Trop de demandes. Réessayez plus tard.' });
      if (!emailOk(b.email)) return res.status(400).json({ error: 'Adresse email invalide.' });
      const email = b.email.trim().toLowerCase();
      const rows = await sb(`petitepart_abonnes?email=eq.${encodeURIComponent(email)}&select=id,statut`);
      if (rows?.[0]) {
        const t = await nouveauJeton(rows[0].id);
        const url = `${origine(req)}/petitepart/?connexion=${t}`;
        await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Petite Part <notifications@ecoskybyrms.fr>', to: [email], subject: 'Votre lien de connexion Petite Part',
            html: `<p>Bonjour,</p><p>Touchez ce bouton depuis le téléphone où vous voulez utiliser Petite Part :</p><p><a href="${url}" style="background:#2F7D4F;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Ouvrir Petite Part</a></p><p style="color:#666;font-size:13px">Si vous n'avez rien demandé, ignorez cet email.</p>` }) });
      }
      return res.status(200).json({ ok: true }); // même réponse que l'email soit connu ou non
    }

    if (action === 'jeton') {
      if (!(await verifierLimite('pp-jet:' + ip, 20, 600))) return res.status(429).json({ error: 'Trop de tentatives.' });
      const a = await abonneDuJeton(b.jeton_email);
      if (!a) return res.status(401).json({ error: 'Lien invalide ou expiré. Demandez-en un nouveau.' });
      return res.status(200).json({ jeton: b.jeton_email, ...etat(a) });
    }

    const a = await abonneDuJeton(b.jeton);
    if (!a) return res.status(401).json({ error: 'Connexion expirée. Demandez un lien de connexion.' });
    await sb(`petitepart_jetons?token_hash=eq.${hash(b.jeton)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_used: new Date().toISOString() }) }).catch(() => {});

    if (action === 'statut') return res.status(200).json(etat(a));

    if (action === 'resilier') {
      if (!a.stripe_subscription || !actif(a.statut)) return res.status(400).json({ error: "Vous n'avez pas d'abonnement payant : rien ne sera prélevé." });
      const s = await stripe.subscriptions.update(a.stripe_subscription, { cancel_at_period_end: true });
      await majAbonne(a.id, s);
      return res.status(200).json({ ok: true, fin_periode: new Date(s.current_period_end * 1000).toISOString() });
    }

    if (action === 'ia') {
      if (!acces(a)) return res.status(402).json({ error: a.statut === 'essai' ? 'Votre essai gratuit est terminé.' : "Votre abonnement n'est plus actif.", essai_fini: a.statut === 'essai' });
      const jour = new Date().toISOString().slice(0, 10);
      const max = actif(a.statut) ? QUOTA_JOUR : QUOTA_ESSAI;
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/petitepart_incrementer_usage`, { method: 'POST', headers: H(), body: JSON.stringify({ p_abonne: a.id, p_jour: jour, p_max: max }) });
      if (!r.ok || (await r.json()) < 0) return res.status(429).json({ error: `Vous avez atteint les ${max} analyses du jour. Rendez-vous demain !` });

      const type = b.type;
      if (type === 'photo') {
        if (typeof b.image !== 'string' || b.image.length > 5_500_000) return res.status(400).json({ error: 'Photo manquante ou trop lourde.' });
        const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(b.image);
        if (!m) return res.status(400).json({ error: 'Format de photo non pris en charge.' });
        const texte = await claude([{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[3] } },
          { type: 'text', text: String(b.prompt || '').slice(0, 4000) },
        ] }], 1500);
        return res.status(200).json({ texte });
      }
      if (type === 'texte') {
        const texte = await claude([{ role: 'user', content: String(b.prompt || '').slice(0, 6000) }], 1500);
        return res.status(200).json({ texte });
      }
      if (type === 'chat') {
        const msgs = Array.isArray(b.messages) ? b.messages.slice(-10).filter((x) => (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string').map((x) => ({ role: x.role, content: x.content.slice(0, 3000) })) : [];
        if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Message vide.' });
        while (msgs.length && msgs[0].role !== 'user') msgs.shift();
        const texte = await claude(msgs, 700, String(b.system || '').slice(0, 3000));
        return res.status(200).json({ texte });
      }
      return res.status(400).json({ error: 'Type inconnu.' });
    }

    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    console.error('petitepart', action, e.message);
    return res.status(500).json({ error: "Une erreur est survenue. Réessayez dans un instant." });
  }
}
