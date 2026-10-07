// /api/prix-travaux-rappel.js
// Étape « téléphone avant la fourchette » de prix-travaux.html (07/10/2026).
// Le visiteur donne son prénom et son mobile, vérifie le numéro par code SMS
// (Twilio Verify, envoyé via /api/verify-send-code), puis voit sa fourchette.
// Le contact est enregistré dans prix_travaux_rappels : Skyeco seul peut le
// rappeler. Il n'est JAMAIS transmis ni vendu à une entreprise (ce n'est pas
// l'option gratuite, qui garde son propre accord dans prix_travaux_contacts).
// Renvoie un jeton qui prouve que ce numéro est vérifié, pour que l'option
// gratuite n'exige pas un second code SMS.
import crypto from 'node:crypto';
import { sb, METIERS, nettoyerReponses } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

export const CONSENTEMENT_RAPPEL = "J'accepte que Skyeco (RESINE MARBRE SOL) me recontacte par téléphone ou SMS au sujet de ce projet. Mon numéro n'est ni vendu ni transmis à des entreprises sans mon accord. Je peux retirer cet accord à tout moment en écrivant à infos@ecosky.fr.";

export function toE164(t) {
  let n = String(t || '').replace(/[^\d+]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (/^0[1-9]\d{8}$/.test(n)) n = '+33' + n.slice(1);
  return /^\+\d{10,15}$/.test(n) ? n : null;
}

// Jeton « numéro vérifié », valable 2 heures.
function cle() { return process.env.SUPABASE_SERVICE_ROLE_KEY || ''; }
export function jetonTelephone(tel, exp = Date.now() + 2 * 3600 * 1000) {
  const sig = crypto.createHmac('sha256', cle()).update(`tel:${tel}:${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}
export function jetonTelephoneValide(tel, jeton) {
  const [exp, sig] = String(jeton || '').split('.');
  if (!tel || !exp || !sig || !cle() || Number(exp) < Date.now()) return false;
  const attendu = jetonTelephone(tel, Number(exp)).split('.')[1];
  const a = Buffer.from(sig), b = Buffer.from(attendu);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

const texte = (v, max = 60) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, max);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('pt-rappel:' + ipDepuisRequete(req), 8, 600))) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  const b = req.body || {};
  const metier = typeof b.metier === 'string' && Object.hasOwn(METIERS, b.metier) ? b.metier : null;
  const reponses = nettoyerReponses(b.reponses);
  const prenom = texte(b.prenom);
  const tel = toE164(b.telephone), code = String(b.code || '').replace(/\D/g, '').slice(0, 10);
  if (!metier || !reponses) return res.status(400).json({ error: 'Projet invalide.' });
  if (prenom.length < 2) return res.status(400).json({ error: 'Indiquez votre prénom.' });
  if (!tel) return res.status(400).json({ error: 'Numéro de mobile invalide.' });
  if (b.consentement !== true) return res.status(400).json({ error: 'Cochez la case pour recevoir votre fourchette.' });
  if (!code) return res.status(400).json({ error: 'Saisissez le code reçu par SMS.' });

  try {
    if (!(await codeValide(tel, code))) return res.status(400).json({ error: 'Code incorrect ou expiré. Vérifiez-le ou demandez un nouveau code.' });
    const est = Number(b.estimation_ttc);
    const estimation = Number.isFinite(est) && est > 0 && est < 1e7 ? Math.round(est) : null;
    const dept = texte(reponses.dept, 3) || null;
    await sb('prix_travaux_rappels', { method: 'POST', body: JSON.stringify({
      prenom, telephone: tel, metier, departement: dept, reponses, estimation_ttc: estimation,
      consentement_texte: CONSENTEMENT_RAPPEL, pub: b.pub === true,
    }) });

    // Alerte pour Cyrille : c'est un contact à rappeler soi-même.
    const resume = `${METIERS[metier]}${dept ? `, dép. ${dept}` : ''}${estimation ? `, environ ${estimation.toLocaleString('fr-FR')} € TTC` : ''}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Skyeco <notifications@ecoskybyrms.fr>', to: [process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr'],
        subject: `À rappeler : ${prenom}, ${resume}`,
        html: `<p>Un visiteur de l'estimateur a vérifié son numéro pour voir sa fourchette de prix.</p><p><strong>${esc(prenom)}</strong> — <a href="tel:${tel}">${tel}</a><br>${esc(resume)}</p><p>Il a accepté d'être rappelé par Skyeco uniquement : ne pas transmettre à une entreprise sans son accord.</p>` }),
    }).catch(() => {});

    return res.status(200).json({ ok: true, jeton_tel: jetonTelephone(tel) });
  } catch (e) {
    console.error('prix-travaux-rappel :', e.message);
    return res.status(500).json({ error: "L'enregistrement a échoué. Réessayez dans un instant." });
  }
}
