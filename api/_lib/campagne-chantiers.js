// /api/_lib/campagne-chantiers.js
// Emailing de recrutement des artisans pour skyeco.fr/chantiers.html, envoyé par lots.
// Ordre d'envoi : ceux qui ont déjà CLIQUÉ, puis ceux qui ont déjà OUVERT (ouvertures humaines,
// hors robots), puis les déjà contactés, puis les jamais contactés. Jamais deux fois la même
// entreprise, jamais un désinscrit, jamais quelqu'un contacté dans les 3 derniers jours.
import { sb } from './prix-travaux-commande.js';

const SITE = 'https://www.skyeco.fr';
const FROM = 'Cyrille de Skyeco <chantiers@ecoskybyrms.fr>';
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SIGLES = new Set(['SARL', 'SAS', 'SASU', 'EURL', 'SA', 'SCI', 'EI', 'EIRL', 'SNC', 'BTP', 'RMS']);
const propre = (n) => String(n || '').trim().replace(/\s+/g, ' ').replace(/\b([A-ZÀ-Ý])([A-ZÀ-Ý']+)\b/g, (m, a, b) => (SIGLES.has(m) ? m : a + b.toLowerCase()));

export const SUJET = 'Des chantiers près de chez vous, le premier est offert';
export function contenu(p, token) {
  const suivi = (a) => `${SITE}/api/campagne-chantiers-suivi?t=${token}&a=${a}`;
  const dep = p.departement ? `du ${esc(p.departement)}` : 'de votre secteur';
  const html = `<div style="font-family:Arial,sans-serif;color:#27394A;max-width:560px;line-height:1.6;font-size:15px">
<p>Bonjour${p.nom_entreprise ? ' ' + esc(propre(p.nom_entreprise)) : ''},</p>
<p>Des particuliers ${dep} estiment leurs travaux sur Skyeco et demandent à être contactés par une entreprise près de chez eux.</p>
<p>Je vous propose de recevoir ces projets :</p>
<ul style="padding-left:20px">
<li>inscription gratuite, sans abonnement ni engagement ;</li>
<li>chaque projet est proposé à 3 entreprises au maximum, avec le téléphone du particulier vérifié par SMS ;</li>
<li><strong>votre premier chantier est offert</strong>, ensuite 19 € ou 39 € HT le contact selon le métier, uniquement si vous le prenez.</li>
</ul>
<p><a href="${suivi('clic')}" style="display:inline-block;background:#E8622C;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Recevoir des chantiers</a></p>
<p>Si un contact s'avère faux, il vous est remplacé.</p>
<p>Cyrille Bon<br>Skyeco by RMS · 06 45 68 83 94</p>
<p style="font-size:11px;color:#8A949C;border-top:1px solid #D5DEE5;padding-top:10px;margin-top:22px">RESINE MARBRE SOL (Skyeco by RMS), SASU, 23 route de Corn er Hoet, 56400 Brech, SIRET 939 997 870 00018. Vous recevez ce message en tant que professionnel du bâtiment. <a href="${suivi('stop')}" style="color:#8A949C">Ne plus recevoir de messages</a></p>
<img src="${suivi('ouv')}" width="1" height="1" alt="" style="display:block;border:0">
</div>`;
  const texte = `Bonjour,\n\nDes particuliers ${p.departement ? 'du ' + p.departement : 'de votre secteur'} estiment leurs travaux sur Skyeco et demandent à être contactés par une entreprise près de chez eux.\n\nInscription gratuite, sans abonnement. Chaque projet est proposé à 3 entreprises au maximum. Votre premier chantier est offert, ensuite 19 € ou 39 € HT le contact, uniquement si vous le prenez.\n\nRecevoir des chantiers : ${suivi('clic')}\n\nCyrille Bon, Skyeco by RMS, 06 45 68 83 94\n\nNe plus recevoir de messages : ${suivi('stop')}`;
  return { html, texte, stop: suivi('stop') };
}

async function resendBatch(messages) {
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(messages),
  });
  if (!r.ok) throw new Error('Resend : ' + (await r.text()));
}

export async function statistiques() {
  const lignes = await sb('campagne_chantiers?select=priorite,statut,ouvert_le,clique_le,envoye_le&limit=100000');
  const inscrits = await sb('artisans_chantiers?select=id&limit=100000');
  const [reglages] = await sb('campagne_chantiers_reglages?id=eq.1&select=*');
  const parPriorite = [1, 2, 3, 4].map((p) => { const l = lignes.filter((x) => x.priorite === p && x.statut !== 'erreur'); return { priorite: p, envoyes: l.length, ouverts: l.filter((x) => x.ouvert_le).length, cliques: l.filter((x) => x.clique_le).length }; });
  const ok = lignes.filter((x) => x.statut !== 'erreur');
  return { reglages, envoyes: ok.length, ouverts: ok.filter((x) => x.ouvert_le).length, cliques: ok.filter((x) => x.clique_le).length, desabonnes: lignes.filter((x) => x.statut === 'desabonne').length, erreurs: lignes.length - ok.length, inscrits: inscrits.length, parPriorite, dernierEnvoi: ok.map((x) => x.envoye_le).sort().pop() || null };
}

// Envoie un lot. test=email : n'envoie qu'un exemple à cette adresse, sans rien enregistrer.
export async function envoyerLot({ taille, test } = {}) {
  if (test) {
    const c = contenu({ nom_entreprise: 'Entreprise Exemple', departement: '56' }, 'exemple');
    await resendBatch([{ from: FROM, to: [test], reply_to: 'infos@ecosky.fr', subject: '[Exemple] ' + SUJET, html: c.html, text: c.texte }]);
    return { envoyes: 1, test: true };
  }
  const n = Math.max(1, Math.min(Number(taille) || 150, 500));
  const prospects = await sb('rpc/prochains_prospects_chantiers', { method: 'POST', body: JSON.stringify({ p_limit: n }) });
  if (!prospects.length) return { envoyes: 0, termine: true };
  const lot = new Date().toISOString().slice(0, 10);
  // On enregistre d'abord : une entreprise enregistrée n'est plus jamais re-sélectionnée, même si l'envoi échoue.
  const lignes = await sb('campagne_chantiers', { method: 'POST', body: JSON.stringify(prospects.map((p) => ({ prospect_id: p.id, email: p.email, lot, priorite: p.priorite }))) });
  const parProspect = Object.fromEntries(lignes.map((l) => [l.prospect_id, l]));
  let envoyes = 0;
  for (let i = 0; i < prospects.length; i += 100) {
    const tranche = prospects.slice(i, i + 100);
    const messages = tranche.map((p) => {
      const c = contenu(p, parProspect[p.id].token);
      return { from: FROM, to: [p.email], reply_to: 'infos@ecosky.fr', subject: SUJET, html: c.html, text: c.texte, headers: { 'List-Unsubscribe': `<${c.stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
    });
    try { await resendBatch(messages); envoyes += tranche.length; }
    catch (e) {
      const ids = tranche.map((p) => parProspect[p.id].id).join(',');
      await sb(`campagne_chantiers?id=in.(${ids})`, { method: 'PATCH', body: JSON.stringify({ statut: 'erreur', erreur: e.message.slice(0, 300) }) }).catch(() => {});
    }
  }
  return { envoyes, prevus: prospects.length, parPriorite: [1, 2, 3, 4].map((k) => prospects.filter((p) => p.priorite === k).length) };
}
