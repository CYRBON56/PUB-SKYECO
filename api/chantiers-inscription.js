// /api/chantiers-inscription.js
// Inscription d'un artisan pour recevoir des chantiers. Téléphone vérifié par SMS,
// identité reprise de la base officielle SIRENE, attestation décennale en PDF.
// Le compte n'est ALERTÉ qu'après validation de la décennale par Cyrille.
import { ficheSiret } from './_lib/sirene.js';
import { sb, METIERS } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };
function toE164(t) { let n = String(t || '').replace(/[^\d+]/g, ''); if (n.startsWith('00')) n = '+' + n.slice(2); if (/^0[1-9]\d{8}$/.test(n)) n = '+33' + n.slice(1); return /^\+\d{10,15}$/.test(n) ? n : null; }
async function codeValide(tel, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const r = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: tel, Code: code }) });
  const j = await r.json().catch(() => ({})); return r.ok && j.status === 'approved';
}
const DEPTS = /^(\d{2}|2A|2B|97\d)$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('ch-inscr:' + ipDepuisRequete(req), 6, 600))) return res.status(429).json({ error: 'Trop de tentatives, patientez quelques minutes.' });
  const b = req.body || {};
  const metiers = [...new Set((Array.isArray(b.metiers) ? b.metiers : []).filter((m) => Object.hasOwn(METIERS, m)))];
  const departements = [...new Set((Array.isArray(b.departements) ? b.departements : []).map((d) => String(d).toUpperCase().trim()).filter((d) => DEPTS.test(d)))].slice(0, 20);
  const tel = toE164(b.telephone), email = String(b.email || '').trim().toLowerCase().slice(0, 120), code = String(b.code || '').replace(/\D/g, '');
  const contactNom = String(b.contact_nom || '').trim().slice(0, 80);
  if (!metiers.length) return res.status(400).json({ error: 'Choisissez au moins un métier.' });
  if (!departements.length) return res.status(400).json({ error: 'Choisissez au moins un département.' });
  if (!tel) return res.status(400).json({ error: 'Numéro de mobile invalide.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide.' });
  if (b.cgv !== true) return res.status(400).json({ error: 'Acceptez les conditions pour continuer.' });
  const pdf = typeof b.decennale === 'string' ? b.decennale.replace(/^data:application\/pdf;base64,/, '') : '';
  const buf = pdf ? Buffer.from(pdf, 'base64') : null;
  if (!buf || buf.length < 1000 || buf.length > 4.5e6 || buf.subarray(0, 4).toString() !== '%PDF') return res.status(400).json({ error: "Joignez votre attestation d'assurance décennale en PDF (4 Mo maximum)." });
  try {
    if (!(await codeValide(tel, code))) return res.status(400).json({ error: 'Code SMS incorrect ou expiré.' });
    const f = await ficheSiret(b.siret);
    if (!f) return res.status(400).json({ error: 'SIRET introuvable dans la base officielle.' });
    if (!f.actif) return res.status(400).json({ error: "Cet établissement n'est pas actif selon la base officielle." });
    const chemin = `${f.siret}/decennale-${Date.now()}.pdf`;
    const up = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/decennales/${chemin}`, { method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/pdf' }, body: buf });
    if (!up.ok) throw new Error('Stockage décennale : ' + (await up.text()));
    const ligne = { siret: f.siret, entreprise: f.entreprise, adresse: `${f.adresse}`, code_ape: f.code_ape, departement_siege: f.departement, contact_nom: contactNom, telephone: tel, email, metiers, departements, decennale_chemin: chemin, decennale_validee: false, actif: true };
    await sb('artisans_chantiers?on_conflict=siret', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(ligne) });
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Skyeco Chantiers <chantiers@ecoskybyrms.fr>', to: [process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr'], subject: `Nouvel artisan à valider : ${f.entreprise}`, html: `<p>${f.entreprise} (SIRET ${f.siret}, APE ${f.code_ape}) s'est inscrit pour : ${metiers.map((m) => METIERS[m]).join(', ')} dans ${departements.join(', ')}.</p><p>Vérifiez sa décennale et validez-le sur <a href="https://www.skyeco.fr/artisans-chantiers.html">skyeco.fr/artisans-chantiers.html</a>.</p>` }) }).catch(() => {});
    return res.status(200).json({ ok: true, entreprise: f.entreprise });
  } catch (e) {
    console.error('chantiers-inscription :', e.message);
    return res.status(500).json({ error: "L'inscription a échoué. Réessayez dans un instant." });
  }
}
