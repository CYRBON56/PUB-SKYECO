// /api/envoyer-bienvenue-essai.js
// Envoie un SMS + un email de bienvenue à l'artisan dès qu'il démarre son
// essai gratuit (bouton "Démarrer mon essai gratuit" sur
// mon-dashboard-demo.html) — avec le lien vers son tableau de bord
// (acces-dashboard.html, qui lui proposera de créer son mot de passe la
// première fois, puis de se connecter les fois suivantes).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER   (déjà utilisées ailleurs)
//   RESEND_API_KEY                                              (déjà utilisée ailleurs)
//
// 08/09/2026 : RESEND_FROM_EMAIL n'existe pas comme variable d'environnement
// séparée — plutôt que d'en exiger la création, l'adresse d'expédition est
// codée en dur ci-dessous sur le seul domaine actuellement vérifié dans le
// compte Resend (ecoskybyrms.fr). Si un jour un domaine dédié (ex : skyeco.fr)
// est vérifié dans Resend, il suffit de changer EXPEDITEUR_EMAIL ci-dessous
// (ou de définir RESEND_FROM_EMAIL, qui reste prioritaire si présent).
const EXPEDITEUR_EMAIL = process.env.RESEND_FROM_EMAIL || 'Skyeco Pro <bonjour@ecoskybyrms.fr>';

import { verifierLimite } from './_lib/rate-limit.js';

const SITE_BASE_URL = 'https://app.skyeco.fr';

// Même logique que envoyer-lien-elements.js : les numéros stockés en base
// sont au format national français ("06 12 34 56 78"), jamais convertis
// avant un envoi Twilio -> conversion nécessaire ici aussi.
function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body, fromOverride) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = fromOverride || process.env.TWILIO_FROM_NUMBER;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Échec envoi SMS');
  return data;
}

async function envoyerEmail(to, entreprise, lien) {
  const from = EXPEDITEUR_EMAIL;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:520px; margin:0 auto; color:#14312a;">
      <p style="font-size:0.78rem; font-weight:700; color:#1e6f4c; text-transform:uppercase; letter-spacing:0.03em; margin:0 0 10px;">Skyeco Pro</p>
      <h1 style="font-size:1.3rem; margin:0 0 16px;">Bienvenue${entreprise ? ', ' + entreprise : ''} !</h1>
      <p style="font-size:0.94rem; line-height:1.6; margin:0 0 16px;">
        Votre essai gratuit d'un mois vient de démarrer — sans engagement, sans carte bancaire.
        Vous pouvez dès maintenant construire votre vitrine et accéder à votre tableau de bord.
      </p>
      <a href="${lien}" style="display:inline-block; background:#e8622c; color:#fff; text-decoration:none; font-weight:700; font-size:0.94rem; padding:14px 26px; border-radius:10px; margin:6px 0 20px;">
        Accéder à mon tableau de bord
      </a>
      <p style="font-size:0.82rem; color:#5b6b64; line-height:1.6; margin:0;">
        Ce lien vous permettra de créer votre identifiant et votre mot de passe la première fois, puis de vous reconnecter à tout moment.
      </p>
      <p style="font-size:0.78rem; color:#8a9891; margin-top:28px;">
        RMS EcoSky (Skyeco Pro) — 23 Route de Corn Er Hoet, 56400 Brech<br>
        <a href="mailto:infos@ecosky.fr" style="color:#8a9891;">infos@ecosky.fr</a>
      </p>
    </div>
  `;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: 'Bienvenue sur Skyeco Pro — votre essai gratuit a démarré',
      html,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Échec envoi email');
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }

  // draftId n'est pas secret (publié dans les URLs Google Ads une fois la
  // campagne lancée) — sans limite, ce endpoint pourrait être appelé en
  // boucle pour harceler un artisan de SMS/emails de bienvenue. Un seul
  // envoi par site toutes les 24h suffit largement à l'usage normal
  // (déclenché une fois, au moment où l'essai démarre).
  const autorise = await verifierLimite(`envoyer-bienvenue-essai:${draftId}`, 1, 24 * 3600);
  if (!autorise) {
    return res.status(200).json({ success: true, dejaEnvoye: true });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=telephone,email,entreprise,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();
    const draft = rows[0];
    if (!draft) return res.status(404).json({ success: false, error: 'Site introuvable.' });

    const lien = `${SITE_BASE_URL}/acces-dashboard.html?id=${draftId}`;
    const resultats = { sms: false, email: false };

    if (draft.telephone) {
      try {
        const texte = `Bienvenue sur Skyeco Pro ! Votre essai gratuit d'un mois a démarré. Accédez à votre tableau de bord : ${lien}`;
        await envoyerSMS(draft.telephone, texte, draft.twilio_phone_number);
        resultats.sms = true;
      } catch (err) {
        console.error('Erreur envoi SMS bienvenue :', err);
      }
    }

    if (draft.email) {
      try {
        await envoyerEmail(draft.email, draft.entreprise, lien);
        resultats.email = true;
      } catch (err) {
        console.error('Erreur envoi email bienvenue :', err);
      }
    }

    return res.status(200).json({ success: true, ...resultats });
  } catch (err) {
    console.error('Erreur envoyer-bienvenue-essai :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
