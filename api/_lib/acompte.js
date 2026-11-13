// api/_lib/acompte.js
// Demande d'acompte par mail (13/11/2026) — utilisé par api/devis-gestion.js
// (envoi manuel) et api/signer-mon-devis.js (envoi automatique après
// signature si skyeco_pro_vitrine_drafts.acompte_auto = true).
//
// Rappel (voir api/devis-gestion.js) : l'outil ne suit PAS l'encaissement.
// On envoie seulement une DEMANDE d'acompte (montant + IBAN et/ou lien de
// paiement fourni par l'artisan) ; l'artisan constate lui-même le paiement.

function echapper(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const euros = n => (Number(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

export function lienPaiementValide(lien) {
  if (!lien) return false;
  try { const u = new URL(lien); return u.protocol === 'https:'; } catch (e) { return false; }
}

export function calculerAcompte(totalTtc, pourcentage) {
  const pct = Number(pourcentage) > 0 && Number(pourcentage) <= 100 ? Number(pourcentage) : 30;
  return { pct, montant: Math.round((Number(totalTtc) || 0) * pct) / 100 };
}

async function envoyerResend({ from, to, replyTo, bcc, subject, html }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo || undefined, bcc: bcc ? [bcc] : undefined, subject, html }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Échec de l'envoi de l'email : ${detail}`);
  }
  return resp.json();
}

// devis : ligne skyeco_pro_devis ; draft : { entreprise, email, iban, lien_paiement, acompte_pourcentage }
export async function envoyerDemandeAcompte(devis, draft) {
  if (!devis.client_email) throw new Error("Ce client n'a pas d'adresse email enregistrée.");
  const iban = (draft.iban || '').trim();
  const lien = lienPaiementValide(draft.lien_paiement) ? draft.lien_paiement : null;
  if (!iban && !lien) throw new Error('Aucun moyen de paiement configuré (IBAN ou lien de paiement).');
  const entreprise = draft.entreprise || 'Votre artisan';
  const { pct, montant } = calculerAcompte(devis.total_ttc, draft.acompte_pourcentage);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;">
<table width="100%" bgcolor="#f4f4f4"><tr><td align="center" style="padding:24px 16px;">
<table width="560" bgcolor="#ffffff" style="max-width:560px;border-radius:8px;overflow:hidden;">
<tr><td style="background:#14213D;padding:24px 32px;"><span style="font-family:Arial,sans-serif;font-size:17px;font-weight:800;color:#fff;">${echapper(entreprise)}</span></td></tr>
<tr><td style="padding:32px;font-family:Arial,sans-serif;color:#1a1a1a;">
<p style="font-size:15px;line-height:23px;margin:0 0 16px 0;">Bonjour${devis.client_nom ? ' ' + echapper(devis.client_nom) : ''},</p>
<p style="font-size:15px;line-height:23px;margin:0 0 16px 0;">Merci pour la signature de votre devis n° ${echapper(devis.numero)}. Pour lancer le chantier, un acompte de <b>${pct} %</b> est demandé, soit :</p>
<p style="font-size:26px;font-weight:800;margin:0 0 20px 0;color:#14213D;">${euros(montant)}</p>
${lien ? `<p style="margin:0 0 20px 0;"><a href="${echapper(lien)}" style="display:inline-block;background:#F5B700;color:#14213D;font-weight:800;text-decoration:none;padding:14px 22px;border-radius:8px;font-size:15px;">Payer l'acompte en ligne</a></p>` : ''}
${iban ? `<p style="font-size:14px;line-height:22px;margin:0 0 6px 0;">${lien ? 'Ou par virement' : 'Par virement'} :</p>
<p style="font-size:14px;line-height:22px;margin:0 0 16px 0;background:#f4f6fa;padding:12px;border-radius:6px;">IBAN : <b>${echapper(iban)}</b><br>Bénéficiaire : ${echapper(entreprise)}<br>Référence : Acompte devis ${echapper(devis.numero)}</p>` : ''}
<p style="font-size:13px;line-height:20px;color:#555;margin:0;">Une question ? Répondez directement à cet email.</p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #eee;font-family:Arial,sans-serif;">
<p style="font-size:11px;color:#888;margin:0;">Demande envoyée via Mon Assistant Pro pour le compte de ${echapper(entreprise)}.</p>
</td></tr></table></td></tr></table></body></html>`;

  await envoyerResend({
    from: `${entreprise} via Skyeco Pro <contact@ecoskybyrms.fr>`,
    to: devis.client_email,
    replyTo: draft.email,
    bcc: draft.email, // l'artisan garde une copie de chaque demande
    subject: `${entreprise} — Acompte pour votre devis n° ${devis.numero}`,
    html,
  });
  return { pct, montant };
}

// Prévient l'artisan qu'un client vient de signer.
export async function notifierSignature(devis, draft, acompte) {
  if (!draft.email) return;
  const html = `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:23px;">Bonne nouvelle : <b>${echapper(devis.client_nom || 'votre client')}</b> vient de signer le devis n° ${echapper(devis.numero)} (${euros(devis.total_ttc)} TTC).</p>
${acompte ? `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:23px;">La demande d'acompte de ${acompte.pct} % (${euros(acompte.montant)}) lui a été envoyée automatiquement par mail.</p>` : `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:23px;">Pensez à lui demander l'acompte depuis votre espace Devis &amp; factures.</p>`}`;
  await envoyerResend({
    from: 'Mon Assistant Pro <contact@ecoskybyrms.fr>',
    to: draft.email,
    subject: `✅ Devis n° ${devis.numero} signé`,
    html,
  });
}
