// /api/_lib/chantiers.js
// Vente des contacts gratuits aux artisans inscrits (skyeco.fr/chantiers.html) :
// prix par métier, jetons de lien sécurisés, alerte des artisans, finalisation d'un achat.
import crypto from 'crypto';
import { sb, METIERS } from './prix-travaux-commande.js';
import { genererFacturePDF } from './prix-travaux-facture.js';

// Prix d'un contact pour l'artisan, en € TTC (HT + TVA 20 %). À ajuster.
const GROS = ['toiture', 'pac', 'isolation', 'ravalement', 'menuiseries', 'piscine', 'anc', 'sdb', 'cuisine', 'terrassement', 'allees', 'resine'];
export const prixChantier = (metier) => (GROS.includes(metier) ? 46.8 : 22.8); // 39 € HT ou 19 € HT
export const MAX_ACHETEURS = 3;
const SITE = 'https://www.skyeco.fr';
const secret = () => process.env.CHANTIERS_SECRET || process.env.DASHBOARD_SESSION_SECRET;

export function jeton(c, a) { return crypto.createHmac('sha256', secret()).update(`${c}:${a}`).digest('hex').slice(0, 32); }
export function jetonValide(c, a, t) {
  if (!/^[0-9a-f-]{36}$/.test(String(c)) || !/^[0-9a-f-]{36}$/.test(String(a)) || !/^[0-9a-f]{32}$/.test(String(t))) return false;
  return crypto.timingSafeEqual(Buffer.from(jeton(c, a)), Buffer.from(String(t)));
}
export const lienChantier = (c, a) => `${SITE}/chantier.html?c=${c}&a=${a}&t=${jeton(c, a)}`;

const UNITES = { toiture: 'm² au sol', ravalement: 'm² au sol', menuiseries: 'menuiserie(s)', anc: 'chambre(s)', pac: 'm² habitables', electricite: 'm² habitables', plomberie: 'm² habitables', clotures: 'm de clôture', cuisine: 'm de meubles', portails: 'm de passage' };
export function resumeAnonyme(c) {
  const q = c.reponses?.qty;
  return `${METIERS[c.metier] || c.metier}${q ? `, ${String(q).replace('.', ',')} ${UNITES[c.metier] || 'm²'}` : ''}, ${c.commune ? c.commune + ' ' : ''}(${c.code_postal})${c.estimation_ttc ? `, budget estimé environ ${Number(c.estimation_ttc).toLocaleString('fr-FR')} € TTC` : ''}`;
}

async function email(to, subject, html, attachments) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Skyeco Chantiers <chantiers@ecoskybyrms.fr>', reply_to: 'infos@ecosky.fr', to: [to], subject, html, ...(attachments ? { attachments } : {}) }),
  });
  if (!r.ok) throw new Error('Resend : ' + (await r.text()));
}
export async function sms(to, body) {
  if (!to || !process.env.TWILIO_FROM_NUMBER) return;
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: body }),
  }).catch(() => {});
}
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cadre = (contenu) => `<div style="font-family:Arial,sans-serif;color:#27394A;max-width:560px;line-height:1.55"><p style="font-size:22px;font-weight:bold;color:#14304A;margin:0 0 16px">SKY<span style="color:#E8622C">ECO</span> <span style="font-size:12px;color:#5B6268;font-weight:normal">Chantiers</span></p>${contenu}<p style="font-size:11px;color:#8A949C;border-top:1px solid #D5DEE5;padding-top:10px;margin-top:22px">RESINE MARBRE SOL (Skyeco by RMS), 23 route de Corn er Hoet, 56400 Brech. SIRET 939 997 870 00018. Vous recevez cet email car vous êtes inscrit sur skyeco.fr/chantiers. Pour ne plus recevoir de chantiers, répondez STOP.</p></div>`;
const bouton = (lien, txt) => `<p><a href="${lien}" style="display:inline-block;background:#E8622C;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">${txt}</a></p>`;

// Alerte les artisans validés du bon métier et du bon département (15 au plus)
export async function notifierArtisans(contact) {
  const artisans = await sb(`artisans_chantiers?actif=eq.true&decennale_validee=eq.true&metiers=cs.{${contact.metier}}&departements=cs.{${encodeURIComponent(contact.departement)}}&select=id,entreprise,email,telephone&limit=15`);
  const resume = resumeAnonyme(contact), prix = prixChantier(contact.metier);
  for (const a of artisans) {
    const lien = lienChantier(contact.id, a.id);
    try {
      await email(a.email, `Nouveau chantier près de chez vous : ${METIERS[contact.metier]} (${contact.code_postal})`, cadre(
        `<p>Bonjour,</p><p>Un particulier cherche une entreprise pour ce projet :</p><p style="background:#F4F7F9;border-radius:8px;padding:12px 14px"><strong>${esc(resume)}</strong><br>Téléphone vérifié par SMS.</p><p>Le contact est réservé aux <strong>3 premières entreprises</strong> qui le prennent, pour ${prix.toFixed(2).replace('.', ',')} € TTC.</p>${bouton(lien, 'Voir et prendre ce chantier')}`));
    } catch (e) { console.error('notifierArtisans :', e.message); }
    await sms(a.telephone, `Skyeco : nouveau chantier ${METIERS[contact.metier]} à ${contact.code_postal}. 3 places. ${lien}`);
  }
  return artisans.length;
}

// Marque l'achat payé, met à jour le contact, facture si payant, envoie les coordonnées. Idempotent.
export async function finaliserAchat(achatId, session) {
  const pris = await sb(`achats_chantiers?id=eq.${achatId}&statut=eq.reserve`, { method: 'PATCH', body: JSON.stringify({ statut: 'paye', ...(session ? { stripe_session_id: session.id } : {}) }) });
  const [achat] = pris.length ? pris : await sb(`achats_chantiers?id=eq.${achatId}&select=*`);
  if (!achat) throw new Error('Achat introuvable');
  const [c] = await sb(`prix_travaux_contacts?id=eq.${achat.contact_id}&select=*`);
  const [a] = await sb(`artisans_chantiers?id=eq.${achat.artisan_id}&select=*`);
  if (!pris.length) return { achat, contact: c, artisan: a }; // déjà finalisé auparavant

  const ventes = [...(c.ventes || []), { entreprise: a.entreprise, siret: a.siret, prix: achat.prix_ttc, date: new Date().toISOString(), achat_id: achat.id }];
  await sb(`prix_travaux_contacts?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ ventes, statut: 'vendu' }) });

  let pieces;
  if (achat.mode === 'stripe' && achat.prix_ttc > 0) {
    const annee = new Date().getFullYear();
    const n = await sb('rpc/prochain_numero_facture', { method: 'POST', body: JSON.stringify({ p_serie: `SKY-CH-${annee}` }) });
    const numero = `SKY-CH-${annee}-${String(n).padStart(5, '0')}`;
    await sb(`achats_chantiers?id=eq.${achat.id}`, { method: 'PATCH', body: JSON.stringify({ facture_numero: numero }) });
    const auj = new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
    const pdf = await genererFacturePDF({
      numero, date: auj, payeLe: auj, reference: (session?.id || achat.id).slice(-14),
      client: { nom: a.entreprise, email: a.email, adresse: a.adresse || '', siret: a.siret },
      lignes: [{ designation: `Mise en relation : projet ${METIERS[c.metier]}`, detail: `Contact particulier vérifié par SMS, ${c.code_postal}, transmis le ${auj}`, ttc: Number(achat.prix_ttc), tauxTva: 0.2 }],
      mentions: ['Prestation de mise en relation avec un particulier ayant donné son accord exprès à la transmission de ses coordonnées.',
        'Facture acquittée. Pour mémoire : pénalités de retard au taux légal majoré et indemnité forfaitaire de 40 € pour frais de recouvrement (article L441-10 du Code de commerce).',
        'Contact faux ou injoignable : signalement possible sous 7 jours depuis la page du chantier, contact remplacé après vérification.'],
    });
    await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/factures-particuliers/chantiers/${numero}.pdf`, {
      method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: pdf,
    }).catch(() => {});
    pieces = [{ filename: `Facture-${numero}.pdf`, content: pdf.toString('base64') }];
  }
  const lien = lienChantier(c.id, a.id);
  await email(a.email, `Coordonnées du client : ${METIERS[c.metier]} (${c.code_postal})`, cadre(
    `<p>Bonjour,</p><p>Voici les coordonnées du particulier. Il a été prévenu qu'il serait contacté par des entreprises de son secteur : appelez-le rapidement, c'est ce qui fait la différence.</p>
    <p style="background:#F4F7F9;border-radius:8px;padding:12px 14px"><strong>${esc(c.prenom)} ${esc(c.nom)}</strong><br>Téléphone : ${esc(c.telephone)}<br>Email : ${esc(c.email)}<br>Lieu des travaux : ${esc(c.commune || '')} ${esc(c.code_postal)}<br>Projet : ${esc(resumeAnonyme(c))}</p>
    <p style="font-size:13px;color:#5B6268">Numéro faux ou projet inexistant ? Signalez-le sous 7 jours depuis la page du chantier : nous vérifions et vous remplaçons le contact.</p>${bouton(lien, 'Revoir le chantier')}${pieces ? '<p>Votre facture est jointe à cet email.</p>' : ''}`), pieces);
  await sms(process.env.ADMIN_PHONE, `Skyeco : chantier ${METIERS[c.metier]} (${c.code_postal}) pris par ${a.entreprise}, ${achat.mode === 'gratuit' ? 'offert' : Number(achat.prix_ttc).toFixed(2) + ' €'}.`);
  return { achat: { ...achat, statut: 'paye' }, contact: c, artisan: a };
}
