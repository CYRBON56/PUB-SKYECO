// /api/definir-mode-vitrine.js
// Enregistre le choix fait par l'artisan sur choisir-forfait.html (14/09/2026,
// nouvelle étape "3 choix" — voir le brief projet
// claude/skyeco-pro-brief-3-choix-vitrine.md) sur ce que l'annonce Google Ads
// doit montrer au prospect qui clique dessus :
//   - 'ia'           : la vitrine générée automatiquement par Skyeco (celle
//                      déjà visible dans l'aperçu en direct de la page) —
//                      comportement historique, choix par défaut.
//   - 'site_externe' : le site personnel de l'artisan (site_web_existant).
//                      L'annonce Google Ads pointera directement dessus (voir
//                      _lib/destination-vitrine.js) — dans ce cas, Skyeco Pro
//                      ne capte aucun lead ni statistique de clic détaillée
//                      pour cette vitrine tant qu'aucun widget n'est installé
//                      dessus (widget pas encore construit — voir le brief).
//   - 'sur_mesure'   : l'artisan préfère que Cyrille lui construise sa
//                      vitrine — envoie une notification admin (même
//                      mécanisme que demander-formulaire-personnalise.js) et
//                      la vitrine Skyeco par défaut reste utilisée en
//                      attendant que Cyrille l'ait construite.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (si mode sur_mesure)
//   RESEND_API_KEY, ADMIN_EMAIL, ADMIN_PHONE (si mode sur_mesure)

import { normaliserUrlSite } from './_lib/destination-vitrine.js';

const MODES_VALIDES = ['ia', 'site_externe', 'sur_mesure'];

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'infos@ecosky.fr';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body) {
  if (!to) throw new Error('ADMIN_PHONE est vide');
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
  });
  if (!resp.ok) throw new Error(`Twilio a répondu ${resp.status} : ${await resp.text()}`);
}

async function envoyerEmail(sujet, texte) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Skyeco Pro <notifications@ecoskybyrms.fr>',
      to: [ADMIN_EMAIL],
      subject: sujet,
      html: `<p>${texte}</p>`,
    }),
  });
  if (!resp.ok) throw new Error(`Resend a répondu ${resp.status} : ${await resp.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, mode, siteUrl, note } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }
  if (!MODES_VALIDES.includes(mode)) {
    return res.status(400).json({ success: false, error: 'mode invalide' });
  }

  let siteUrlNormalisee = null;
  if (mode === 'site_externe') {
    siteUrlNormalisee = normaliserUrlSite(siteUrl);
    if (!siteUrlNormalisee) {
      return res.status(400).json({ success: false, error: "L'adresse de votre site n'est pas valide." });
    }
  }
  const noteTrim = typeof note === 'string' ? note.trim() : '';

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const patch = { mode_vitrine: mode };
    // Le site personnel n'est écrasé que si l'artisan a effectivement choisi
    // cette option — pour ne jamais effacer une valeur déjà en base (ex. la
    // renseigner ici, puis revenir sur 'ia', ne doit pas perdre l'URL saisie).
    if (mode === 'site_externe') {
      patch.site_web_existant = siteUrlNormalisee;
    }

    const patchResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }
    );
    if (!patchResp.ok) throw new Error(await patchResp.text());

    if (mode === 'sur_mesure') {
      try {
        const getResp = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,telephone,email`,
          { headers: supaHeaders }
        );
        const rows = await getResp.json();
        const { entreprise, telephone, email } = rows[0] || {};
        const nomAffiche = entreprise || 'Un artisan';
        const coordonnees = [telephone, email].filter(Boolean).join(' — ');
        const lienDashboard = `https://www.skyeco.fr/mon-dashboard.html?id=${draftId}`;
        const texte = `🔔 ${nomAffiche} a choisi de faire construire sa vitrine sur mesure par Skyeco (choisir-forfait.html — choix "vitrine sur mesure").${coordonnees ? ' Contact : ' + coordonnees + '.' : ''}${noteTrim ? ' Besoin décrit : "' + noteTrim + '".' : ''} En attendant, sa vitrine générée automatiquement reste diffusée. Dashboard : ${lienDashboard}`;

        const resultats = await Promise.allSettled([
          envoyerSMS(ADMIN_PHONE, texte),
          envoyerEmail('🔔 Vitrine sur mesure demandée — ' + nomAffiche, texte),
        ]);
        const [resultSms, resultEmail] = resultats;
        if (resultSms.status === 'rejected') console.error('Échec envoi SMS definir-mode-vitrine :', resultSms.reason);
        if (resultEmail.status === 'rejected') console.error('Échec envoi email definir-mode-vitrine :', resultEmail.reason);
      } catch (e) {
        // La notification admin est secondaire : le choix est déjà enregistré
        // en base, on ne fait pas échouer la requête pour autant.
        console.error('Erreur notification sur-mesure (definir-mode-vitrine) :', e);
      }
    }

    return res.status(200).json({ success: true, siteUrl: siteUrlNormalisee });
  } catch (err) {
    console.error('Erreur definir-mode-vitrine :', err);
    return res.status(500).json({ success: false, error: "Impossible d'enregistrer votre choix pour le moment." });
  }
}
