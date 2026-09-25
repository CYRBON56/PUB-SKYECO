// /api/estimateur-btp-essai.js
// Démarre (ou renvoie, si déjà démarré) l'essai gratuit de 2 jours de
// l'Estimateur BTP (public/estimateur-btp.html), à partir d'un simple email
// — pas de mot de passe, pas de carte bancaire.
//
// ⚠️ Changement du 25/09/2026 (deux revirements le même jour, tranchés
// définitivement par Cyrille) : après l'essai gratuit de 2 jours, l'accès
// devient payant via un ACHAT UNIQUE et FIXE de 29,90€ HT (voir
// api/estimateur-btp-checkout.js, mode 'payment') — PAS un abonnement
// mensuel qui se renouvelle tout seul. "Pas de forfait" visait l'abonnement
// récurrent, pas l'essai lui-même, qui reste bien présent.
//
// Cas particulier important : toute personne ayant déjà acheté le "Kit Pro
// Artisan BTP" (table kit_pro_commandes) reçoit un accès illimité et
// automatique — ce produit à 29€ incluait déjà un lien vers l'Estimateur BTP
// en bonus, sans restriction, AVANT que celui-ci ne devienne un produit payant
// séparé. On ne casse pas cette promesse déjà faite aux acheteurs existants.
//
// Idempotent : un email qui a déjà un essai en cours (ou déjà acheté) se voit
// renvoyer son état existant, jamais réinitialisé.
//
// Envoie aussi un email de bienvenue expliquant le fonctionnement du
// catalogue de prix préintégré — uniquement au tout premier démarrage
// (jamais renvoyé aux visites suivantes, voir dejaDemarre). Un échec d'envoi
// d'email n'empêche jamais de démarrer l'essai (c'est secondaire par rapport
// à l'accès lui-même).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

import { blocCommentCaMarcheEstimateur } from './_lib/estimateur-btp-email.js';

const DUREE_ESSAI_JOURS = 2;
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

async function envoyerEmailBienvenue(email, dejaClientKitPro) {
  const intro = dejaClientKitPro
    ? `<p>Votre achat du <strong>Kit Pro Artisan BTP</strong> vous donne un accès illimité et gratuit à l'Estimateur BTP — pas d'essai à surveiller, rien d'autre à payer.</p>`
    : `<p>Votre essai gratuit de <strong>${DUREE_ESSAI_JOURS} jours</strong> vient de démarrer — sans carte bancaire. À la fin de l'essai, l'accès continue pour <strong>29,90€ HT</strong> si vous souhaitez garder l'appli : un paiement unique, sans abonnement ni prélèvement récurrent.</p>`;
  const html = `
    <div style="font-family:Arial, sans-serif; color:#222; max-width:560px; margin:0 auto;">
      <h2 style="color:#1F3A5F;">Bienvenue sur l'Estimateur BTP</h2>
      ${intro}
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
      subject: dejaClientKitPro
        ? 'Votre Estimateur BTP — accès illimité (Kit Pro)'
        : 'Bienvenue — votre essai gratuit Estimateur BTP a démarré',
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
    essai_fin: row.essai_fin,
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
    // 1) Déjà un accès enregistré (essai en cours, déjà acheté, ou déjà
    //    repéré comme acheteur Kit Pro) ? On ne réinitialise jamais.
    const existants = await supabaseRequest(
      `estimateur_btp_acces?email=eq.${encodeURIComponent(email)}&select=*&limit=1`
    );
    if (Array.isArray(existants) && existants.length > 0) {
      return res.status(200).json({ success: true, ...etatPourReponse(existants[0]), dejaDemarre: true });
    }

    // 2) Pas encore d'accès : a-t-il déjà acheté le Kit Pro Artisan BTP ?
    const achatsKitPro = await supabaseRequest(
      `kit_pro_commandes?email=eq.${encodeURIComponent(email)}&statut=eq.paye&select=id&limit=1`
    );
    const dejaClientKitPro = Array.isArray(achatsKitPro) && achatsKitPro.length > 0;

    const maintenant = new Date();
    const nouvelleLigne = dejaClientKitPro
      ? {
          email,
          abonnement_actif: true,
          source: 'kit_pro',
          essai_debut: null,
          essai_fin: null,
        }
      : {
          email,
          abonnement_actif: false,
          source: 'essai',
          essai_debut: maintenant.toISOString(),
          essai_fin: new Date(maintenant.getTime() + DUREE_ESSAI_JOURS * 24 * 60 * 60 * 1000).toISOString(),
        };

    const inserted = await supabaseRequest('estimateur_btp_acces', {
      method: 'POST',
      body: JSON.stringify(nouvelleLigne),
    });

    // Best-effort : un échec d'envoi d'email ne doit jamais faire échouer le
    // démarrage de l'essai lui-même (l'accès est déjà enregistré ci-dessus).
    try {
      await envoyerEmailBienvenue(email, dejaClientKitPro);
    } catch (err) {
      console.error('estimateur-btp-essai : email de bienvenue non envoyé —', err.message);
    }

    return res.status(200).json({ success: true, ...etatPourReponse(inserted[0]), dejaDemarre: false });
  } catch (err) {
    console.error('estimateur-btp-essai error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur, réessayez.' });
  }
}
