// /api/estimateur-btp-essai.js
// Vérifie l'accès d'un email à l'Estimateur BTP (public/estimateur-btp.html).
//
// ⚠️ Changement du 25/09/2026 : il n'y a plus d'essai gratuit ni
// d'abonnement — l'Estimateur BTP est un ACHAT UNIQUE et FIXE de 29,90€ HT
// (voir api/estimateur-btp-checkout.js). Ce endpoint (dont le nom de fichier
// n'a volontairement pas changé, pour ne pas casser les pages qui l'appellent
// déjà) ne fait donc plus que deux choses :
//   1) Si l'email a déjà un accès enregistré (achat Stripe, ou achat du
//      "Kit Pro Artisan BTP" qui inclut ce produit en bonus), on le renvoie
//      tel quel — jamais réinitialisé.
//   2) Sinon, on NE CRÉE RIEN : on renvoie simplement dejaAchete:false, et
//      c'est au front-end d'enchaîner sur /api/estimateur-btp-checkout pour
//      lancer le paiement.
//
// Cas particulier conservé : toute personne ayant déjà acheté le "Kit Pro
// Artisan BTP" (table kit_pro_commandes) reçoit un accès illimité et gratuit
// automatique — ce produit à 29€ incluait déjà un lien vers l'Estimateur BTP
// en bonus, sans restriction, AVANT que celui-ci ne devienne un produit payant
// séparé. On ne casse pas cette promesse déjà faite aux acheteurs existants.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

import { blocCommentCaMarcheEstimateur } from './_lib/estimateur-btp-email.js';

const EXPEDITEUR_EMAIL = process.env.RESEND_FROM_EMAIL_ESTIMATEUR || 'Estimateur BTP <notifications@ecoskybyrms.fr>';

function emailValide(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function envoyerEmailAccesKitPro(email) {
  const html = `
    <div style="font-family:Arial, sans-serif; color:#222; max-width:560px; margin:0 auto;">
      <h2 style="color:#1F3A5F;">Bienvenue sur l'Estimateur BTP</h2>
      <p>Votre achat du <strong>Kit Pro Artisan BTP</strong> vous donne un accès illimité et gratuit à l'Estimateur BTP — rien à payer, rien à surveiller.</p>
      <p style="margin:0 0 4px;"><a href="https://www.skyeco.fr/estimateur-btp.html" style="color:#1F3A5F; font-weight:bold;">https://www.skyeco.fr/estimateur-btp.html</a></p>
      <p style="margin:0 0 4px; font-size:13px; color:#666;">Ouvrez ce lien depuis votre téléphone, puis ajoutez la page à votre écran d'accueil (bouton 📲 « Installer l'appli » en haut de l'appli) pour l'utiliser comme une application, même sans connexion internet sur un chantier isolé.</p>
      <div style="margin-top:24px; padding:18px; background:#F2F2F2; border-radius:10px;">
        ${blocCommentCaMarcheEstimateur()}
      </div>
      <p style="margin-top:24px; color:#666; font-size:13px;">Une question ? Répondez simplement à cet email.</p>
    </div>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EXPEDITEUR_EMAIL,
      to: [email],
      subject: 'Votre Estimateur BTP — accès illimité (Kit Pro)',
      html,
    }),
  });
  if (!resp.ok) {
    throw new Error('Resend a refusé l\'envoi : ' + (await resp.text()));
  }
}

function etatPourReponse(row) {
  return {
    email: row.email,
    abonnement_actif: row.abonnement_actif,
    source: row.source,
    reglages: row.reglages || null,
    overrides: row.overrides || null,
    postesPerso: row.postes_perso || null,
    postesMasques: row.postes_masques || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!emailValide(email)) {
    return res.status(400).json({ success: false, error: 'Email invalide' });
  }

  try {
    // 1) Déjà un accès enregistré (achat Stripe, ou déjà repéré comme
    //    acheteur Kit Pro) ? On ne réinitialise jamais.
    const existants = await supabaseRequest(
      `estimateur_btp_acces?email=eq.${encodeURIComponent(email)}&select=*&limit=1`
    );
    if (Array.isArray(existants) && existants.length > 0) {
      return res.status(200).json({ success: true, ...etatPourReponse(existants[0]), dejaAchete: true });
    }

    // 2) Pas encore d'accès : a-t-il déjà acheté le Kit Pro Artisan BTP ?
    const achatsKitPro = await supabaseRequest(
      `kit_pro_commandes?email=eq.${encodeURIComponent(email)}&statut=eq.paye&select=id&limit=1`
    );
    const dejaClientKitPro = Array.isArray(achatsKitPro) && achatsKitPro.length > 0;

    if (dejaClientKitPro) {
      const inserted = await supabaseRequest('estimateur_btp_acces', {
        method: 'POST',
        body: JSON.stringify({
          email,
          abonnement_actif: true,
          source: 'kit_pro',
          essai_debut: null,
          essai_fin: null,
        }),
      });

      // Best-effort : un échec d'envoi d'email ne doit jamais faire échouer
      // l'accès lui-même (déjà enregistré ci-dessus).
      try {
        await envoyerEmailAccesKitPro(email);
      } catch (err) {
        console.error('estimateur-btp-essai : email Kit Pro non envoyé —', err.message);
      }

      return res.status(200).json({ success: true, ...etatPourReponse(inserted[0]), dejaAchete: true });
    }

    // 3) Ni accès existant, ni achat Kit Pro : on ne crée rien ici. Le
    // paiement (29,90€ HT, achat unique) se fait via
    // /api/estimateur-btp-checkout, qui accordera l'accès une fois le
    // paiement confirmé (voir api/stripe-webhook.js).
    return res.status(200).json({ success: true, email, abonnement_actif: false, dejaAchete: false });
  } catch (err) {
    console.error('estimateur-btp-essai error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur, réessayez.' });
  }
}
