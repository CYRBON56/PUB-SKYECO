// /api/aides-pac.js (01/10/2026)
// Simulateur d'aides PAC (public/aides-pompe-a-chaleur.html) : enregistre la demande
// du particulier dans aides_pac_demandes et prévient Cyrille par email (Resend).
// La simulation est recalculée côté navigateur ; on la stocke telle quelle, à titre
// indicatif, après nettoyage (le texte libre est limité en longueur).
import { sb } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

const CONSENTEMENT = "J'accepte que Skyeco (RESINE MARBRE SOL) utilise ces informations pour préparer mon dossier d'aides et me recontacter au sujet de mon projet de pompe à chaleur. Je peux retirer mon accord à tout moment en écrivant à infos@ecosky.fr.";

const txt = (v, n = 120) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function nettoyerObjet(o, prof = 0) {
  if (prof > 2 || !o || typeof o !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 40)) {
    if (!/^[a-zA-Z_]{1,30}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = txt(v, 200);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = nettoyerObjet(v, prof + 1);
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!(await verifierLimite('aides-pac:' + ipDepuisRequete(req), 8, 3600))) return res.status(429).json({ error: 'Trop de demandes. Réessayez plus tard.' });
  const b = req.body || {};
  const prenom = txt(b.prenom, 60), nom = txt(b.nom, 60), email = txt(b.email, 120), telephone = txt(b.telephone, 20);
  const code_postal = txt(b.code_postal, 5), commune = txt(b.commune, 80), adresse = txt(b.adresse, 160);
  if (!prenom || !nom) return res.status(400).json({ error: 'Indiquez votre prénom et votre nom.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide.' });
  if (!/^0[1-9](\d{8})$/.test(telephone.replace(/[\s.-]/g, ''))) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  if (!/^\d{5}$/.test(code_postal)) return res.status(400).json({ error: 'Code postal invalide.' });
  if (b.accord !== true) return res.status(400).json({ error: "Cochez la case d'accord pour recevoir votre dossier." });
  const simulation = nettoyerObjet(b.simulation) || {};
  const reponses = nettoyerObjet(b.reponses) || {};
  try {
    const [d] = await sb('aides_pac_demandes', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ prenom, nom, email, telephone: telephone.replace(/[\s.-]/g, ''), adresse, code_postal, commune,
        projet: txt(reponses.projet, 20), categorie: txt(simulation.categorie, 20), simulation, reponses, consentement_texte: CONSENTEMENT }),
    });
    if (process.env.RESEND_API_KEY) {
      const projet = reponses.projet === 'air_eau' ? 'PAC air/eau' : 'PAC air/air';
      await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Skyeco Aides PAC <notifications@ecoskybyrms.fr>', to: [process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr'],
          subject: `Nouvelle demande d'aides ${projet} : ${prenom} ${nom} (${code_postal})`,
          html: `<p><strong>${esc(prenom)} ${esc(nom)}</strong>, ${esc(commune)} (${esc(code_postal)})<br>${esc(telephone)} · ${esc(email)}</p>
<p>Projet : ${esc(projet)} · Profil : ${esc(simulation.categorie || '?')}<br>
Aides estimées : ${esc(simulation.total_min ?? '?')} à ${esc(simulation.total_max ?? '?')} €</p>
<p>Fiche complète dans Supabase, table aides_pac_demandes (id ${esc(d?.id)}).</p>`,
        }),
      }).catch((e) => console.error('aides-pac email :', e.message));
    }
    return res.status(200).json({ ok: true, id: d?.id || null });
  } catch (e) {
    console.error('aides-pac :', e.message);
    return res.status(500).json({ error: "L'envoi a échoué. Réessayez dans un instant." });
  }
}
