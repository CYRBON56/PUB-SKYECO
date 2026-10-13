// /api/petitepart-rappels.js
// 11/10/2026 — Rappels « Qu'avez-vous mangé ? » de l'appli Petite Part (notifications sur le téléphone).
//   POST ?action=abonner     {sub, moments, appareil} -> enregistre le téléphone
//   POST ?action=desabonner  {endpoint}               -> arrête les rappels
//   POST ?action=notes       {endpoint, jour, notes}  -> moments déjà notés aujourd'hui (pas de rappel inutile)
//   GET  (Vercel Cron, toutes les heures)             -> envoie le rappel du moment, heure de Paris :
//        matin 10 h · midi 14 h · goûter 17 h · soir 21 h (le soir rappelle aussi les grignotages)
// Aucun repas n'est stocké ici : seulement l'adresse de notification du téléphone et les moments déjà notés.
// Variables : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CRON_SECRET.
// Table : petitepart_rappels.
import webpush from 'web-push';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const MOMENTS = ['matin', 'midi', 'gouter', 'soir'];
const HEURES = { 10: 'matin', 14: 'midi', 17: 'gouter', 21: 'soir' };
const TEXTES = {
  matin: { title: "☀️ Qu'avez-vous mangé ce matin ?", body: 'Notez votre petit-déjeuner en 10 secondes.' },
  midi: { title: '🍽️ Et ce midi, c\'était quoi ?', body: "Une photo de l'assiette et c'est noté." },
  gouter: { title: '🍎 Un goûter ou un petit grignotage ?', body: 'Notez-le, même petit : tout compte.' },
  soir: { title: "🌙 Qu'avez-vous mangé ce soir ?", body: 'Et un grignotage dans la journée ? Notez-le pour un bilan juste.' },
};

const H = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' });
async function sb(path, opts = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...H(), Prefer: 'return=representation', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`supabase ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const paris = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { jour: `${p.year}-${p.month}-${p.day}`, heure: +p.hour };
};
const okEndpoint = (e) => typeof e === 'string' && /^https:\/\/[^\s]{10,900}$/.test(e);
const okMoments = (m) => (Array.isArray(m) ? m.filter((x) => MOMENTS.includes(x)) : MOMENTS);
const okNotes = (m) => (Array.isArray(m) ? m.filter((x) => MOMENTS.includes(x) || x === 'grignotage') : []);

async function envoyer() {
  const { jour, heure } = paris();
  const moment = HEURES[heure];
  if (!moment) return { moment: null, envoyes: 0 };
  webpush.setVapidDetails('mailto:infos@ecosky.fr', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const rows = (await sb(`petitepart_rappels?moments=cs.{${moment}}&select=*`)) || [];
  let n = 0;
  const payload = JSON.stringify({ ...TEXTES[moment], url: `/?moment=${moment}`, tag: 'pp-' + moment });
  for (let i = 0; i < rows.length; i += 20) {
    await Promise.all(rows.slice(i, i + 20).map(async (r) => {
      const deja = (r.notes_jour === jour && r.notes.includes(moment)) || (r.envoyes_jour === jour && r.envoyes.includes(moment));
      if (deja) return;
      const ep = encodeURIComponent(r.endpoint);
      try {
        await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, { TTL: 3 * 3600, urgency: 'normal' });
        n++;
        const envoyes = r.envoyes_jour === jour ? [...r.envoyes, moment] : [moment];
        await sb(`petitepart_rappels?endpoint=eq.${ep}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ envoyes_jour: jour, envoyes, echecs: 0 }) });
      } catch (e) {
        // Téléphone désabonné ou appli désinstallée : on retire l'adresse.
        if (e.statusCode === 404 || e.statusCode === 410 || r.echecs >= 5) await sb(`petitepart_rappels?endpoint=eq.${ep}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => {});
        else await sb(`petitepart_rappels?endpoint=eq.${ep}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ echecs: r.echecs + 1 }) }).catch(() => {});
        console.error('petitepart-rappels envoi', e.statusCode || e.message);
      }
    }));
  }
  return { moment, envoyes: n, abonnes: rows.length };
}

// Comptes offerts (gratuits, propriétaire) : si un abonnement Stripe traîne encore dessus, on l'annule
// et on passe le compte en « offert ». Même liste que dans api/petitepart.js.
const OFFERTS = ['infos@ecosky.fr', 'c.bon@ecosky.fr'];
async function balayerOfferts() {
  const liste = OFFERTS.map((e) => `"${e}"`).join(',');
  const rows = await sb(`petitepart_abonnes?email=in.(${encodeURIComponent(liste)})&statut=neq.offert&select=id,email,stripe_subscription`);
  for (const a of rows || []) {
    await sb(`petitepart_abonnes?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify({ statut: 'offert', stripe_subscription: null, fin_periode: null, updated_at: new Date().toISOString() }) });
    if (a.stripe_subscription) {
      const r = await fetch(`https://api.stripe.com/v1/subscriptions/${a.stripe_subscription}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } });
      console.log('petitepart offert: abonnement Stripe annulé', a.stripe_subscription, r.status);
    }
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Non autorisé' });
    try { await balayerOfferts(); } catch (e) { console.error('petitepart offerts', e.message); }
    try { const r = await envoyer(); console.log('petitepart-rappels', r); return res.status(200).json(r); }
    catch (e) { console.error('petitepart-rappels', e.message); return res.status(500).json({ error: e.message }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const action = req.query.action;
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const ip = ipDepuisRequete(req);
  if (!(await verifierLimite('pp-rap:' + ip, 60, 600))) return res.status(429).json({ error: 'Trop de demandes.' });
  try {
    if (action === 'abonner') {
      const s = b.sub || {};
      if (!okEndpoint(s.endpoint) || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return res.status(400).json({ error: 'Abonnement invalide.' });
      await sb('petitepart_rappels?on_conflict=endpoint', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ endpoint: s.endpoint, p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100), appareil: String(b.appareil || '').slice(0, 80) || null, moments: okMoments(b.moments), echecs: 0, updated_at: new Date().toISOString() }) });
      return res.status(200).json({ ok: true });
    }
    if (!okEndpoint(b.endpoint)) return res.status(400).json({ error: 'Adresse invalide.' });
    const ep = encodeURIComponent(b.endpoint);
    if (action === 'desabonner') {
      await sb(`petitepart_rappels?endpoint=eq.${ep}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return res.status(200).json({ ok: true });
    }
    if (action === 'notes') {
      const jour = /^\d{4}-\d{2}-\d{2}$/.test(b.jour) ? b.jour : paris().jour;
      await sb(`petitepart_rappels?endpoint=eq.${ep}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ notes_jour: jour, notes: okNotes(b.notes), ...(Array.isArray(b.moments) ? { moments: okMoments(b.moments) } : {}) }) });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    console.error('petitepart-rappels', action, e.message);
    return res.status(500).json({ error: 'Une erreur est survenue.' });
  }
}
