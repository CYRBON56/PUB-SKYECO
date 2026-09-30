// /api/prix-travaux-contact.js
// Option gratuite de prix-travaux.html : le particulier obtient son estimation détaillée
// en échange de son accord pour être contacté par 3 entreprises au maximum.
// Le téléphone est vérifié par code SMS (Twilio Verify, envoyé via /api/verify-send-code)
// AVANT tout enregistrement : on ne vend jamais un contact au faux numéro.
// Variables : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_VERIFY_SERVICE_SID, RESEND_API_KEY ; facultatives : ADMIN_PHONE, TWILIO_FROM_NUMBER.
import { sb, METIERS, nettoyerReponses } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';
import { artisansEligibles, jetonClient } from './_lib/chantiers.js';

export const CONSENTEMENT = "J'accepte que Skyeco (RESINE MARBRE SOL) transmette mes coordonnées et la description de mon projet aux entreprises que je choisirai parmi celles qui me seront présentées (3 au maximum), pour qu'elles me contactent au sujet de mes travaux. Ce service est gratuit pour moi car ces entreprises paient Skyeco pour ce contact. Je peux retirer mon accord à tout moment en écrivant à infos@ecosky.fr.";

function toE164(t) {
  let n = String(t || '').replace(/[^\d+]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (/^0[1-9]\d{8}$/.test(n)) n = '+33' + n.slice(1);
  return /^\+\d{10,15}$/.test(n) ? n : null;
}
function departementDepuisCP(cp) {
  if (cp.startsWith('97')) return cp.slice(0, 3);
  if (cp.startsWith('20')) return Number(cp) < 20200 ? '2A' : '2B';
  return cp.slice(0, 2);
}
const FAUX = new Set(['test', 'toto', 'titi', 'tata', 'azerty', 'qwerty', 'aaa', 'xxx', 'abc', 'nom', 'prenom', 'prénom', 'anonyme', 'inconnu', 'moi', 'personne', 'client', 'monsieur', 'madame', 'mr', 'mme', 'na', 'none', 'null']);
function nomPlausible(v) {
  const n = v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return n.length >= 2 && /^[a-z' -]+$/.test(n) && !FAUX.has(n) && !/(.)\1\1/.test(n) && (n.length <= 3 || /[aeiouy]/.test(n));
}
async function communeValide(cp, commune) {
  try {
    const r = await fetch(`https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=nom&format=json`);
    const l = await r.json();
    if (!Array.isArray(l) || !l.length) return null;
    return l.find((x) => x.nom.toLowerCase() === String(commune || '').toLowerCase())?.nom || null;
  } catch { return undefined; } // API indisponible : on n'empêche pas l'enregistrement
}
const texte = (v, max = 60) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, max);

async function codeValide(tel, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const r = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: tel, Code: code }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.status === 'approved';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('pt-contact:' + ipDepuisRequete(req), 8, 600))) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  const b = req.body || {};
  const metier = typeof b.metier === 'string' && Object.hasOwn(METIERS, b.metier) ? b.metier : null;
  const reponses = nettoyerReponses(b.reponses);
  const prenom = texte(b.prenom), nom = texte(b.nom), email = texte(b.email, 120).toLowerCase(), cp = texte(b.code_postal, 5);
  const tel = toE164(b.telephone), code = String(b.code || '').replace(/\D/g, '').slice(0, 10);
  if (!metier || !reponses) return res.status(400).json({ error: 'Projet invalide.' });
  if (!prenom || !nom) return res.status(400).json({ error: 'Indiquez votre prénom et votre nom.' });
  if (!nomPlausible(prenom) || !nomPlausible(nom) || prenom.toLowerCase() === nom.toLowerCase()) return res.status(400).json({ error: 'Indiquez vos vrais prénom et nom : les entreprises en ont besoin pour vous contacter.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide.' });
  if (!/^\d{5}$/.test(cp)) return res.status(400).json({ error: 'Code postal invalide (5 chiffres).' });
  if (!tel) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  if (b.consentement !== true) return res.status(400).json({ error: "Votre accord est nécessaire pour l'option gratuite." });
  if (!code) return res.status(400).json({ error: 'Saisissez le code reçu par SMS.' });

  const commune = await communeValide(cp, b.commune);
  if (commune === null) return res.status(400).json({ error: 'Choisissez la commune des travaux dans la liste.' });
  try {
    if (!(await codeValide(tel, code))) return res.status(400).json({ error: 'Code incorrect ou expiré. Vérifiez-le ou demandez un nouveau code.' });
    const est = Number(b.estimation_ttc);
    const [c] = await sb('prix_travaux_contacts', { method: 'POST', body: JSON.stringify({
      prenom, nom, telephone: tel, email, code_postal: cp, commune: commune || texte(b.commune, 80) || null, departement: departementDepuisCP(cp),
      metier, reponses, estimation_ttc: Number.isFinite(est) && est > 0 && est < 1e7 ? Math.round(est) : null,
      consentement_texte: CONSENTEMENT, artisans_choisis: [],
    }) });

    // Alerte pour Cyrille (sans bloquer le visiteur en cas d'échec)
    const resume = `${METIERS[metier]}, ${c.code_postal}${c.estimation_ttc ? `, environ ${c.estimation_ttc.toLocaleString('fr-FR')} € TTC` : ''}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Skyeco <notifications@ecoskybyrms.fr>', to: [process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr'], subject: `Nouveau contact gratuit : ${resume}`,
        html: `<p>Nouveau contact à proposer aux entreprises : <strong>${resume}</strong>.</p><p>Téléphone vérifié par SMS. Gérez-le sur <a href="https://www.skyeco.fr/contacts-prix-travaux.html">skyeco.fr/contacts-prix-travaux.html</a>.</p>` }),
    }).catch(() => {});
    if (process.env.ADMIN_PHONE && process.env.TWILIO_FROM_NUMBER) {
      const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: process.env.ADMIN_PHONE, From: process.env.TWILIO_FROM_NUMBER, Body: `Skyeco : nouveau contact gratuit à vendre (${resume}).` }),
      }).catch(() => {});
    }
    // Depuis le 30/09/2026 : le particulier choisit ses entreprises (voir /api/prix-travaux-choix)
    const liste = await artisansEligibles(c).catch(() => []);
    const entreprises = liste.map((a) => ({ id: a.id, entreprise: a.entreprise, adresse: a.adresse || '', siret: a.siret || '' }));
    return res.status(200).json({ ok: true, contact_id: c.id, jeton: jetonClient(c.id), entreprises });
  } catch (e) {
    console.error('prix-travaux-contact :', e.message);
    return res.status(500).json({ error: "L'enregistrement a échoué. Réessayez dans un instant." });
  }
}
