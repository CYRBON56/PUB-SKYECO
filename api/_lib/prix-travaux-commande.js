// /api/_lib/prix-travaux-commande.js
// Logique commune au webhook Stripe et à la page de retour de paiement :
// marque la commande payée, attribue un numéro de facture continu, génère la
// facture PDF, l'archive dans Supabase Storage, l'envoie au client par email
// (Resend) et prévient Cyrille par SMS. Idempotent : peut être appelé plusieurs
// fois pour la même session Stripe sans créer de doublon ni de trou de numérotation.

import { genererFacturePDF, euros } from './prix-travaux-facture.js';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const BUCKET = 'factures-particuliers';
export const PRIX_TTC = 35.9;
export const METIERS = {
  toiture: 'Toiture', ravalement: 'Façade', resine: 'Sol en résine', allees: 'Allées', terrasses: 'Terrasses',
  clotures: 'Clôtures', portails: 'Portails', terrassement: 'Terrassement', piscine: 'Piscine', anc: 'Assainissement',
  isolation: 'Isolation', pac: 'Pompe à chaleur', menuiseries: 'Menuiseries', sdb: 'Salle de bain', cuisine: 'Cuisine',
  sols: 'Sols intérieurs', peinture: 'Peinture', platrerie: 'Plâtrerie', electricite: 'Électricité', plomberie: 'Plomberie',
};

export async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Supabase ${path} : ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// N'accepte que des réponses simples : clés alphabétiques, nombres ou codes courts.
// Empêche l'injection de texte ou de code via les réponses enregistrées.
export function nettoyerReponses(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  for (const [k, v] of Object.entries(r).slice(0, 40)) {
    if (!/^[A-Za-z_]{1,20}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6) out[k] = v;
    else if (typeof v === 'string' && /^[A-Za-z0-9_.,-]{0,40}$/.test(v)) out[k] = v;
  }
  return out;
}

const dateFR = (d = new Date()) => d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
const echapper = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function notifierAdminSMS(texte) {
  const to = process.env.ADMIN_PHONE; if (!to) return;
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: texte }),
    });
  } catch (e) { console.error('SMS admin :', e.message); }
}

async function envoyerEmail({ to, numero, metierNom, lien, pdf }) {
  const html = `<div style="font-family:Arial,sans-serif;color:#27394A;max-width:560px;line-height:1.55">
  <p style="font-size:22px;font-weight:bold;color:#14304A;margin:0 0 18px">SKY<span style="color:#E8622C">ECO</span> <span style="font-size:12px;color:#5B6268;font-weight:normal">by RMS</span></p>
  <p>Bonjour,</p>
  <p>Merci pour votre achat. Votre estimation détaillée <strong>${echapper(metierNom)}</strong> est disponible :</p>
  <p><a href="${lien}" style="display:inline-block;background:#E8622C;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Ouvrir mon estimation</a></p>
  <p style="font-size:13px;color:#5B6268">Gardez cet email : ce lien vous permet de revenir à votre projet, de modifier vos options et de comparer d'autres devis.</p>
  <p><strong>Récapitulatif</strong><br>Estimation détaillée de travaux : ${echapper(metierNom)}<br>Montant : ${euros(PRIX_TTC)} TTC, payé par carte bancaire<br>Facture n° ${echapper(numero)}, jointe à cet email</p>
  <p style="font-size:13px;color:#5B6268">Conformément à votre demande lors du paiement, vous avez obtenu un accès immédiat à votre estimation et renoncé à votre droit de rétractation dès le début de son utilisation (article L221-28, 13° du Code de la consommation). Nos conditions générales de vente : <a href="https://www.skyeco.fr/cgv-estimateur.html">skyeco.fr/cgv-estimateur.html</a></p>
  <p>Une question ? Répondez simplement à cet email.</p>
  <p>L'équipe Skyeco</p>
  <p style="font-size:11px;color:#8A949C;border-top:1px solid #D5DEE5;padding-top:10px">RESINE MARBRE SOL (Skyeco by RMS), SASU au capital de 50 000 €, 23 route de Corn er Hoet, 56400 Brech. SIRET 939 997 870 00018, RCS Lorient.</p></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL_PRIX_TRAVAUX || 'Skyeco <factures@ecoskybyrms.fr>',
      to: [to], reply_to: 'infos@ecosky.fr',
      bcc: [process.env.ADMIN_EMAIL || 'infos@ecosky.fr'],
      subject: `Votre estimation Skyeco et votre facture n° ${numero}`,
      html,
      attachments: [{ filename: `Facture-${numero}.pdf`, content: pdf.toString('base64') }],
    }),
  });
  if (!r.ok) throw new Error('Resend : ' + (await r.text()));
}

export async function finaliserCommande(session, origin = 'https://www.skyeco.fr') {
  if (session.payment_status !== 'paid') return { paye: false };
  const id = session.metadata?.commande_id;
  if (!id) throw new Error('commande_id absent des métadonnées Stripe');

  const cd = session.customer_details || {};
  const a = cd.address || {};
  const adresse = [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.country === 'FR' ? 'France' : a.country].filter(Boolean).join('\n');

  // 1. On « réserve » la commande : une seule exécution peut passer ici.
  const pris = await sb(`prix_travaux_commandes?id=eq.${id}&statut=in.(en_attente,erreur)`, {
    method: 'PATCH',
    body: JSON.stringify({ statut: 'traitement', stripe_session_id: session.id, email: cd.email || session.customer_email, nom: cd.name || null, adresse, paye_le: new Date().toISOString() }),
  });
  if (!pris.length) {
    const [c] = await sb(`prix_travaux_commandes?id=eq.${id}&select=*`);
    return { paye: true, commande: c };
  }
  let c = pris[0];
  const metierNom = METIERS[c.metier] || c.metier;
  try {
    // 2. Numéro de facture (réutilisé si une tentative précédente l'avait déjà attribué)
    let numero = c.facture_numero;
    if (!numero) {
      const annee = new Date().getFullYear();
      const n = await sb('rpc/prochain_numero_facture', { method: 'POST', body: JSON.stringify({ p_serie: `SKY-PT-${annee}` }) });
      numero = `SKY-PT-${annee}-${String(n).padStart(5, '0')}`;
      await sb(`prix_travaux_commandes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ facture_numero: numero }) });
    }
    // 3. Facture PDF
    const pdf = await genererFacturePDF({
      numero, date: dateFR(), payeLe: dateFR(), reference: session.id.slice(-14),
      client: { nom: c.nom, email: c.email, adresse: c.adresse },
      lignes: [{ designation: `Estimation détaillée de travaux : ${metierNom}`, detail: `Département ${c.departement}, quantité déclarée ${String(c.quantite).replace('.', ',')}, accès immédiat au contenu numérique`, ttc: PRIX_TTC, tauxTva: 0.2 }],
    });
    const chemin = `${new Date().getFullYear()}/${numero}.pdf`;
    const up = await fetch(`${SB}/storage/v1/object/${BUCKET}/${chemin}`, {
      method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: pdf,
    });
    if (!up.ok) console.error('Archivage facture :', await up.text());
    // 4. Email client (facture jointe)
    const lien = `${origin}/prix-travaux.html?paiement=ok&session_id=${session.id}`;
    await envoyerEmail({ to: c.email, numero, metierNom, lien, pdf });
    [c] = await sb(`prix_travaux_commandes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ statut: 'payee', facture_chemin: chemin, email_envoye: true }) });
    await notifierAdminSMS(`Skyeco : nouvelle vente estimateur ${metierNom} (dép. ${c.departement}), 35,90 € TTC. Facture ${numero}.`);
    return { paye: true, commande: c };
  } catch (e) {
    console.error('finaliserCommande :', e.message);
    await sb(`prix_travaux_commandes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ statut: 'erreur' }) }).catch(() => {});
    await notifierAdminSMS(`Skyeco : paiement reçu mais erreur facture/email pour la commande ${id} (${e.message.slice(0, 80)}). À vérifier.`);
    // Le client a payé : on lui donne quand même accès à son estimation.
    const [c2] = await sb(`prix_travaux_commandes?id=eq.${id}&select=*`);
    return { paye: true, commande: c2 };
  }
}
