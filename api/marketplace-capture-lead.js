// /api/marketplace-capture-lead.js
// Capture publique d'un lead "marketplace Skyeco" (16/09/2026) — reçu depuis
// public/devis-resine-epdm-morbihan.html, une page SANS artisan précis :
// c'est Skyeco elle-même qui capte ce prospect (budget pub Skyeco, pas celui
// d'un artisan), pour le revendre ensuite en exclusivité à UN SEUL artisan
// via api/marketplace-reserver-lead.js + api/marketplace-confirmer-achat.js.
//
// Généralisé le 16/09/2026 (voir claude/skyeco-pro-brief-marketplace-leads.md) :
// au départ le métier/département étaient fixés en dur ici (pilote résine/56
// uniquement). Cyrille veut un vrai système multi-métiers, où chaque artisan
// voit des contacts selon SON activité déclarée — cet endpoint accepte donc
// désormais metier/departement en paramètres (envoyés par la page de
// capture), validés contre la même liste de métiers que le reste du produit
// (skyeco_pro_vitrine_drafts.metier) pour éviter qu'un appel direct
// n'injecte une valeur arbitraire. Repli sur résine/56 si absents, pour ne
// pas casser la page de capture existante si elle n'était pas encore mise à
// jour.
//
// Contrairement à api/notify-nouvelle-demande.js (demande reçue par un
// artisan précis sur SA vitrine), aucun artisan n'est notifié ici — seul
// Cyrille (admin) l'est, puisque personne n'a encore acheté ce contact.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (notif admin + accusé prospect)
//   RESEND_API_KEY (notif admin)
//   ADMIN_PHONE, ADMIN_EMAIL (reprend les mêmes valeurs que api/stripe-webhook.js)

import { ipDepuisRequete, verifierLimite } from './_lib/rate-limit.js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'infos@ecosky.fr';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';
// Même liste que celle utilisée pour le métier d'une vitrine artisan (voir
// METIER_LABELS dans api/analyser-site-vitrine.js) — un lead marketplace ne
// peut être catégorisé que sous un métier que le produit connaît déjà.
const METIERS_CONNUS = ['paysagiste', 'piscine', 'tonte', 'terrasse', 'paysagiste_concepteur', 'arboriste', 'espaces_verts', 'resine', 'autre'];
const METIER_DEFAUT = 'resine';
const DEPARTEMENT_DEFAUT = '56';
const PRIX_CTS = 3000; // 30,00 € TTC pour tous les métiers — décision du 16/09/2026

function departementValide(valeur) {
  return typeof valeur === 'string' && /^[0-9][0-9A-Za-z]{1,2}$/.test(valeur.trim());
}

function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return null;
}

async function envoyerSMS(to, texte) {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) return;
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: texte }),
    });
  } catch (e) {
    console.error('Erreur SMS marketplace-capture-lead :', e);
  }
}

async function envoyerEmailAdmin(sujet, texte) {
  try {
    if (!process.env.RESEND_API_KEY) return;
    await fetch('https://api.resend.com/emails', {
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
  } catch (e) {
    console.error('Erreur email admin marketplace-capture-lead :', e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const {
    nom, prenom, telephone, telephoneVerifie, email,
    commune, codePostal, typeProjet, surfaceM2, budgetIndicatif, reponses,
    metier, departement, zoneRegion,
  } = req.body || {};

  if (!telephone || !telephoneVerifie) {
    return res.status(400).json({ success: false, error: 'Numéro de téléphone non vérifié.' });
  }

  const metierFinal = METIERS_CONNUS.includes(metier) ? metier : METIER_DEFAUT;
  const departementFinal = departementValide(departement) ? departement.trim() : DEPARTEMENT_DEFAUT;

  // Anti-abus : un même numéro ne peut pas spammer la table (protège aussi
  // contre un rejeu accidentel du formulaire).
  const ip = ipDepuisRequete(req);
  const phoneE164 = toE164(telephone);
  const [autoriseParNumero, autoriseParIp] = await Promise.all([
    verifierLimite(`marketplace-capture:tel:${phoneE164 || telephone}`, 3, 60 * 60),
    verifierLimite(`marketplace-capture:ip:${ip}`, 10, 60 * 60),
  ]);
  if (!autoriseParNumero || !autoriseParIp) {
    return res.status(429).json({ success: false, error: 'Trop de tentatives. Merci de réessayer plus tard.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const insertResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads_marketplace`, {
      method: 'POST',
      headers: { ...supaHeaders, Prefer: 'return=representation' },
      body: JSON.stringify([{
        metier: metierFinal,
        departement: departementFinal,
        zone_region: zoneRegion || 'Bretagne',
        commune: commune || null,
        code_postal: codePostal || null,
        type_projet: typeProjet || null,
        surface_m2: surfaceM2 || null,
        budget_indicatif: budgetIndicatif || null,
        reponses: reponses || {},
        nom: nom || null,
        prenom: prenom || null,
        telephone: telephone || null,
        telephone_verifie: true,
        email: email || null,
        prix_cts: PRIX_CTS,
        statut: 'disponible',
        capture_ip: ip,
      }]),
    });
    if (!insertResp.ok) {
      const errData = await insertResp.json().catch(() => ({}));
      console.error('Erreur insertion lead marketplace :', JSON.stringify(errData));
      return res.status(500).json({ success: false, error: "Votre demande n'a pas pu être enregistrée." });
    }

    const prenomAffiche = prenom || 'Bonjour';

    // Accusé de réception au prospect — volontairement sans promettre UN
    // artisan précis (aucun n'a encore acheté ce contact à cet instant).
    if (phoneE164) {
      await envoyerSMS(
        phoneE164,
        `${prenomAffiche}, merci pour votre demande de devis (Skyeco). Un professionnel qualifié de notre réseau va revenir vers vous très prochainement.`
      );
    }

    // Notification admin — Cyrille reste le filet de sécurité tant qu'un
    // artisan n'a pas acheté le contact (relance manuelle possible si le
    // lead reste disponible trop longtemps).
    const texteAdmin = `🎯 Nouveau lead marketplace Skyeco (${metierFinal}, dept. ${departementFinal}, ${commune || codePostal || ''}) — ${prenom || ''} ${nom || ''}, ${telephone || ''}. Disponible à la vente (${(PRIX_CTS / 100).toFixed(2)}€) dans le dashboard des artisans éligibles.`;
    await Promise.allSettled([
      ADMIN_PHONE ? envoyerSMS(ADMIN_PHONE, texteAdmin) : Promise.resolve(),
      envoyerEmailAdmin('🎯 Nouveau lead marketplace Skyeco', texteAdmin),
    ]);

    return res.status(200).json({
      success: true,
      message: 'Votre demande a bien été enregistrée — un professionnel va vous recontacter prochainement.',
    });
  } catch (err) {
    console.error('Erreur marketplace-capture-lead :', err);
    return res.status(500).json({ success: false, error: "Votre demande n'a pas pu être enregistrée." });
  }
}
