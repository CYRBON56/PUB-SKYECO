// api/_lib/precommande.js
// 09/10/2026 — Précommandes des 3 applis d'hiver (test de la demande avant de
// les construire). Le client paie maintenant ; l'appli lui est livrée à sa
// sortie, au plus tard à la DATE_LIMITE, sinon il est remboursé intégralement.
// Table Supabase : precommandes (une ligne par paiement).

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };

export const DATE_LIMITE = '30 novembre 2026';

export const PRODUITS = {
  'meteo-chantier': { nom: 'Météo Chantier', prix: 19.9, page: 'meteo-chantier.html', pitch: "l'appli qui vous dit chaque matin, chantier par chantier, si vous pouvez couler, poser ou peindre" },
  'stock-granules': { nom: 'Mon Stock Granulés', prix: 9.9, page: 'stock-granules.html', pitch: "l'appli qui vous dit jusqu'à quand tiendra votre stock de granulés ou de bois et quand recommander" },
  'facture-chauffage': { nom: 'Ma Facture Chauffage', prix: 9.9, page: 'facture-chauffage.html', pitch: "l'appli qui prévoit votre facture de chauffage de l'hiver et vous alerte quand la consommation dérape" },
};

export async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Supabase ${path} : ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const echapper = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const euros = (n) => n.toFixed(2).replace('.', ',') + ' €';

async function smsAdmin(texte) {
  const to = process.env.ADMIN_PHONE; if (!to) return;
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: texte }),
    });
  } catch (e) { console.error('SMS admin précommande :', e.message); }
}

async function emailConfirmation(p, c) {
  const html = `<div style="font-family:Arial,sans-serif;color:#1d2a36;max-width:560px;line-height:1.55">
  <img src="https://www.skyeco.fr/images/skyeco-logo-email.png" width="160" height="52" alt="Skyeco" style="display:block;margin-bottom:14px;"><p style="font-size:20px;font-weight:bold;margin:0 0 16px">${echapper(p.nom)}</p>
  <p>Bonjour${c.nom ? ' ' + echapper(c.nom.split(' ')[0]) : ''},</p>
  <p>Merci, votre précommande de <strong>${echapper(p.nom)}</strong> est confirmée : ${echapper(p.pitch)}.</p>
  <p><strong>Ce qui se passe maintenant</strong><br>
  Vous recevrez par email le lien d'installation dès la sortie de l'appli, au plus tard le ${DATE_LIMITE}.
  Si elle n'est pas sortie à cette date, vous êtes remboursé intégralement et automatiquement, sans rien avoir à demander.
  Vous pouvez aussi annuler à tout moment avant la sortie en répondant à cet email : remboursement intégral.</p>
  <p><strong>Récapitulatif</strong><br>${echapper(p.nom)}, précommande<br>Montant : ${euros(p.prix)} TTC, payé par carte bancaire</p>
  <p>Une idée de fonction qui vous serait utile ? Répondez à cet email : les premiers clients orientent ce qu'on construit.</p>
  <p>Cyrille Bon<br>Skyeco</p>
  <p style="font-size:11px;color:#7a8794;border-top:1px solid #d8dee4;padding-top:10px">Skyeco, édité par RESINE MARBRE SOL, SASU au capital de 50 000 €, 23 route de Corn er Hoet, 56400 Brech. SIRET 939 997 870 00018, RCS Lorient.</p></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL_PRIX_TRAVAUX || 'Skyeco <factures@ecoskybyrms.fr>',
      to: [c.email], reply_to: 'infos@ecosky.fr', bcc: [process.env.ADMIN_EMAIL || 'infos@ecosky.fr'],
      subject: `Précommande confirmée : ${p.nom}`,
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend : ' + (await r.text()));
}

// Idempotent : appelé par la page de retour ET par le webhook Stripe.
export async function finaliserPrecommande(session) {
  if (session.payment_status !== 'paid') return { paye: false };
  const id = session.metadata?.precommande_id;
  if (!id) throw new Error('precommande_id absent des métadonnées Stripe');
  const cd = session.customer_details || {};
  const pris = await sb(`precommandes?id=eq.${id}&statut=eq.en_attente`, {
    method: 'PATCH',
    body: JSON.stringify({ statut: 'payee', email: cd.email || session.customer_email, nom: cd.name || null, paye_le: new Date().toISOString() }),
  });
  if (!pris.length) {
    const [c] = await sb(`precommandes?id=eq.${id}&select=*`);
    return { paye: true, precommande: c };
  }
  const c = pris[0], p = PRODUITS[c.produit];
  const total = await sb(`precommandes?produit=eq.${c.produit}&statut=eq.payee&select=id`);
  await smsAdmin(`Précommande ${p.nom} : ${euros(p.prix)} (${c.email}). Total ${total.length} pour ce produit.`);
  try { await emailConfirmation(p, c); } catch (e) { console.error('Email précommande :', e.message); }
  return { paye: true, precommande: c };
}
