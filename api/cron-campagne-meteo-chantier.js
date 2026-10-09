// /api/cron-campagne-meteo-chantier.js
// 09/10/2026 — Campagne email « Météo Chantier » (test de précommande), validée
// par Cyrille le 09/10. Cible : artisans ayant RÉELLEMENT ouvert au moins un
// email (paysagistes, gros œuvre/VRD, isolation/enveloppe, rénovation, second
// œuvre), ~1 320 contacts. Chaque contact ne reçoit cet email qu'une fois
// (table campagne_envois). Envoi progressif par lots, jours ouvrés, à partir
// du lundi 12/10/2026 (voir vercel.json).
// Pour arrêter la campagne : retirer son entrée de "crons" dans vercel.json,
// ou mettre ACTIVE à false ci-dessous.

import { SUJET_METEO_CHANTIER, HTML_METEO_CHANTIER, DESTINATION_METEO_CHANTIER } from './_lib/email-meteo-chantier.js';

const ACTIVE = true;
const CAMPAGNE = 'meteo-chantier';
const DEBUT = '2026-10-12T06:00:00Z'; // lundi 12 octobre, 8h heure de Paris
const TAILLE_LOT = 35;
const FAMILLES = ['Paysagisme & espaces verts', 'Gros œuvre / VRD', 'Isolation / enveloppe (RGE)', 'Rénovation (RGE)', 'Second œuvre / finitions'];
const BASE_URL = 'https://www.skyeco.fr';
const FROM = 'Skyeco <notifications@ecoskybyrms.fr>';
const PHOTO = 'https://www.skyeco.fr/images/cyrille-bon-prospection-v2.jpg';

const SB = () => process.env.SUPABASE_URL;
const H = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' });
const esc = (v) => String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => Buffer.from(Array.from({ length: 8 }, () => Math.floor(Math.random() * 256))).toString('base64url').slice(0, 10);

async function patchProspect(id, corps) {
  await fetch(`${SB()}/rest/v1/prospects_paysagiste?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...H(), Prefer: 'return=minimal' }, body: JSON.stringify(corps) });
}
async function noter(id, statut, erreur = null) {
  await fetch(`${SB()}/rest/v1/campagne_envois`, { method: 'POST', headers: { ...H(), Prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify({ campagne: CAMPAGNE, prospect_id: id, statut, erreur }) });
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Non autorisé' });
  if (!ACTIVE) return res.status(200).json({ message: 'Campagne désactivée.' });
  if (Date.now() < Date.parse(DEBUT)) return res.status(200).json({ message: `Campagne programmée à partir du ${DEBUT}.` });

  const r = await fetch(`${SB()}/rest/v1/rpc/prochain_lot_campagne`, { method: 'POST', headers: H(), body: JSON.stringify({ p_campagne: CAMPAGNE, p_familles: FAMILLES, p_limit: TAILLE_LOT }) });
  if (!r.ok) return res.status(500).json({ error: 'Lecture Supabase : ' + (await r.text()) });
  const lot = await r.json();
  if (!lot.length) return res.status(200).json({ envoyes: 0, message: 'Campagne terminée : plus aucun contact à servir.' });

  let envoyes = 0, echecs = 0;
  for (const p of lot) {
    // Lien suivi : on réutilise le jeton du contact et on pointe sa destination vers Météo Chantier
    // (api/lien.js relit lien_clic_destination côté serveur).
    let t = p.clic_token;
    if (!t) t = token();
    await patchProspect(p.id, { clic_token: t, lien_clic_destination: DESTINATION_METEO_CHANTIER });
    const desab = `${BASE_URL}/d?p=${t}`;
    const html = HTML_METEO_CHANTIER
      .replaceAll('{{nom_entreprise}}', esc(p.nom_entreprise))
      .replaceAll('{{ville}}', esc(p.ville))
      .replaceAll('{{metier}}', esc(p.metier))
      .replaceAll('{{lien_cta}}', `${BASE_URL}/l?p=${t}`)
      + `<p style="font-size:11px;color:#999;margin-top:24px;">Vous recevez cet email de la part de Skyeco. <a href="${desab}" style="color:#999;">Se désabonner</a></p>`
      + `<img src="${BASE_URL}/o?p=${t}" width="1" height="1" alt="" style="display:block;border:0;" />`;
    try {
      const e = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM, to: [p.email], reply_to: 'infos@ecosky.fr', subject: SUJET_METEO_CHANTIER, html,
          headers: { 'List-Unsubscribe': `<${desab}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
          attachments: [{ path: PHOTO, filename: 'cyrille-bon.jpg', content_id: 'signature-cyrille' }],
        }),
      });
      if (!e.ok) {
        const msg = (await e.json().catch(() => ({}))).message || `Resend ${e.status}`;
        if (/daily_quota_exceeded|rate.?limit.*exceeded.*day/i.test(msg)) break; // on reprendra au prochain passage
        if (/invalid.*(email|recipient|address)|domain.*not.*exist|does not exist/i.test(msg)) await patchProspect(p.id, { bounced: true, bounce_reason: msg });
        await noter(p.id, 'echec', msg.slice(0, 300)); echecs++;
      } else {
        await noter(p.id, 'envoye');
        await patchProspect(p.id, { last_contact_at: new Date().toISOString() });
        envoyes++;
      }
    } catch (err) { echecs++; console.error('campagne meteo-chantier :', err.message); }
    await dormir(350);
  }
  console.log(`Campagne ${CAMPAGNE} : ${envoyes} envoyés, ${echecs} échecs`);
  return res.status(200).json({ envoyes, echecs });
}
