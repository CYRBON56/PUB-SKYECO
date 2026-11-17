// /api/avis-pro-inscription.js
// Inscription d'un artisan au service Avis Pro (gestion des avis Google).
// Identité reprise de la base officielle SIRENE, demande enregistrée dans
// avis_pro_inscriptions, puis Cyrille est prévenu par mail pour le rappel.
import { ficheSiret } from './_lib/sirene.js';
import { sb } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

function toE164(t) { let n = String(t || '').replace(/[^\d+]/g, ''); if (n.startsWith('00')) n = '+' + n.slice(2); if (/^0[1-9]\d{8}$/.test(n)) n = '+33' + n.slice(1); return /^\+\d{10,15}$/.test(n) ? n : null; }
const txt = (v, max) => String(v || '').replace(/[<>]/g, '').trim().slice(0, max);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('avispro:' + ipDepuisRequete(req), 6, 600))) return res.status(429).json({ error: 'Trop de tentatives, patientez quelques minutes.' });
  const b = req.body || {};
  const tel = toE164(b.telephone);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  const forfait = ['starter', 'pro'].includes(b.forfait) ? b.forfait : null;
  const compte = ['oui', 'non', 'ne-sais-pas'].includes(b.compte_google) ? b.compte_google : 'ne-sais-pas';
  const ton = ['vous', 'tu'].includes(b.ton) ? b.ton : 'vous';
  if (!tel) return res.status(400).json({ error: 'Numéro de mobile invalide.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide.' });
  if (!forfait) return res.status(400).json({ error: 'Choisissez un forfait.' });
  if (b.autorisation !== true) return res.status(400).json({ error: 'Merci de cocher l\'autorisation pour continuer.' });
  try {
    const f = await ficheSiret(b.siret);
    if (!f) return res.status(400).json({ error: 'SIRET introuvable dans la base officielle.' });
    if (!f.actif) return res.status(400).json({ error: "Cet établissement n'est pas actif selon la base officielle." });
    const ligne = {
      siret: f.siret, entreprise: f.entreprise, adresse: f.adresse,
      contact_nom: txt(b.contact_nom, 80), telephone: tel, email,
      fiche_google: txt(b.fiche_google, 300), compte_google: compte, forfait,
      mise_en_place: b.mise_en_place === true, ton, signature_reponse: txt(b.signature_reponse, 80),
      autorisation: true,
    };
    const cree = await sb('avis_pro_inscriptions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(ligne) });
    const ins = cree && cree[0];
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Skyeco Avis Pro <chantiers@ecoskybyrms.fr>', to: [process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr'],
        subject: `Nouvelle inscription Avis Pro : ${f.entreprise}`,
        html: `<p><b>${esc(f.entreprise)}</b> (SIRET ${esc(f.siret)}) veut le forfait <b>${forfait === 'pro' ? 'Pro' : 'Starter'}</b>${ligne.mise_en_place ? ' + mise en place clé en main' : ''}.</p>
<p>Contact : ${esc(ligne.contact_nom)} — ${esc(tel)} — ${esc(email)}<br>Fiche Google : ${esc(ligne.fiche_google) || 'non précisée'}<br>Compte Google : ${esc(compte)}<br>Ton des réponses : ${esc(ton)} — signature : ${esc(ligne.signature_reponse) || '(par défaut)'}</p>
<p>À faire : le rappeler sous 24 h, créer dans Qonto sa facture récurrente mensuelle (${forfait === 'pro' ? '49' : '29'} € HT) avec paiement par prélèvement SEPA, et lui envoyer l'adresse à ajouter comme gestionnaire de sa fiche.</p>` }) }).catch(() => {});
    return res.status(200).json({ ok: true, entreprise: f.entreprise, id: ins?.id, jeton: ins ? `${ins.siret}-${new Date(ins.created_at).getTime()}` : null });
  } catch (e) {
    console.error('avis-pro-inscription :', e.message);
    return res.status(500).json({ error: "L'inscription a échoué. Réessayez dans un instant." });
  }
}
