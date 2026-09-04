// /api/prospection-send-batch.js
//
// Envoi par LOT de la campagne d'emailing "prospection artisans" (vendre
// l'abonnement Skyeco Pro à d'autres artisans du BTP — table
// prospects_paysagiste, généralisée le 04/09 pour couvrir tous les métiers,
// pas seulement les paysagistes malgré le nom de la table/page).
//
// Conçu pour un envoi progressif ("petit à petit", ~19 000 contacts au
// total côté Cyrille) plutôt qu'un envoi massif d'un coup : chaque appel
// n'envoie QUE le prochain lot (batchSize, prospects jamais encore
// contactés), jamais toute la base. Protégé par le même mot de passe
// interne que le reste de la page de prospection.
//
// Requête attendue : POST
//   { motDePasseInterne, batchSize, metier?, subject, html, videoUrl? }
//   - html doit contenir le jeton {{lien_cta}} à l'endroit du bouton
//     d'appel à l'action (remplacé par le lien de tracking /l?p=...).
//   - videoUrl (optionnel) : destination du clic (ex: la vidéo de démo) ;
//     sans elle, le lien pointe vers la page d'inscription Skyeco Pro.
//   - Placeholders disponibles dans "html" : {{nom_entreprise}}, {{ville}},
//     {{metier}}, {{lien_cta}}.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
//   INTERNAL_ACCESS_PASSWORD

const RESEND_FROM = 'Skyeco Pro <notifications@ecoskybyrms.fr>';
const BASE_URL = 'https://www.skyeco.fr';
const BATCH_SIZE_MAX = 500; // filet de sécurité — un envoi "petit à petit" ne doit jamais dériver vers un envoi massif accidentel

function genererToken() {
  const octets = Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
  return Buffer.from(octets).toString('base64url').slice(0, 10);
}

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class QuotaJournalierAtteint extends Error {}

// Certaines réponses Resend indiquent sans ambiguïté une adresse invalide
// (pas juste un problème temporaire) — on marque directement ces
// contacts comme "obsolètes" plutôt que de les retenter à chaque lot.
function estAdresseInvalide(message) {
  return /invalid.*(email|recipient|address)|domain.*not.*exist|does not exist/i.test(message || '');
}

async function envoyerUnEmail(to, subject, html, lienDesabonnement) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      html,
      headers: {
        'List-Unsubscribe': `<${lienDesabonnement}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const message = data.message || `Resend a répondu ${resp.status}`;
    if (/daily_quota_exceeded|rate.?limit.*exceeded.*day/i.test(message)) throw new QuotaJournalierAtteint(message);
    const err = new Error(message);
    err.invalideAdresse = estAdresseInvalide(message);
    throw err;
  }
  return resp.json();
}

function echapperHtml(v) {
  return String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { motDePasseInterne, batchSize, metier, subject, html, videoUrl } = req.body || {};

  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }
  const taille = Math.min(parseInt(batchSize, 10) || 50, BATCH_SIZE_MAX);
  if (!subject || !html || !html.includes('{{lien_cta}}')) {
    return res.status(400).json({ success: false, error: 'Sujet manquant, ou contenu sans {{lien_cta}} pour le bouton d\'appel à l\'action.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Sélectionne le prochain lot : jamais contacté, pas désabonné, pas marqué obsolète.
    let filtre = `email=not.is.null&opt_out=eq.false&bounced=eq.false&email_envoye=eq.false`;
    if (metier) filtre += `&metier=eq.${encodeURIComponent(metier)}`;
    const lotResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?${filtre}&select=id,nom_entreprise,ville,metier,email,clic_token&order=created_at.asc&limit=${taille}`,
      { headers: supaHeaders }
    );
    if (!lotResp.ok) throw new Error('Lecture Supabase impossible : ' + (await lotResp.text()));
    const lot = await lotResp.json();

    if (!lot.length) {
      return res.status(200).json({ success: true, envoyes: 0, echoues: 0, marquesObsoletes: 0, quotaAtteint: false, restants: 0, message: 'Aucun contact restant à envoyer pour ce filtre.' });
    }

    const idLot = new Date().toISOString();
    const resultats = [];
    let quotaAtteint = false;
    let marquesObsoletes = 0;

    for (const p of lot) {
      if (quotaAtteint) { resultats.push({ id: p.id, success: false, error: 'Non tenté : quota journalier atteint.' }); continue; }

      // Jeton de tracking (clic + ouverture + désabonnement) — généré une
      // fois, conservé si un futur envoi devait le retenter.
      let token = p.clic_token;
      if (!token) {
        token = genererToken();
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?id=eq.${encodeURIComponent(p.id)}`, {
          method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ clic_token: token }),
        });
      }

      const lienCta = `${BASE_URL}/l?p=${token}` + (videoUrl ? `&to=${encodeURIComponent(videoUrl)}` : '');
      const lienDesabonnement = `${BASE_URL}/d?p=${token}`;
      const pixelOuverture = `${BASE_URL}/o?p=${token}`;

      const htmlPersonnalise = html
        .replaceAll('{{nom_entreprise}}', echapperHtml(p.nom_entreprise))
        .replaceAll('{{ville}}', echapperHtml(p.ville))
        .replaceAll('{{metier}}', echapperHtml(p.metier))
        .replaceAll('{{lien_cta}}', lienCta)
        + `<p style="font-size:11px;color:#999;margin-top:24px;">Vous recevez cet email de la part de Skyeco Pro (RMS EcoSky). <a href="${lienDesabonnement}" style="color:#999;">Se désabonner</a></p>`
        + `<img src="${pixelOuverture}" width="1" height="1" alt="" style="display:block;border:0;" />`;

      try {
        await envoyerUnEmail(p.email, subject, htmlPersonnalise, lienDesabonnement);
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?id=eq.${encodeURIComponent(p.id)}`, {
          method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ email_envoye: true, date_envoi_email: new Date().toISOString(), statut: 'envoye_email', lot_envoi: idLot, last_contact_at: new Date().toISOString() }),
        });
        resultats.push({ id: p.id, success: true });
      } catch (err) {
        if (err instanceof QuotaJournalierAtteint) {
          quotaAtteint = true;
          resultats.push({ id: p.id, success: false, error: 'Quota journalier Resend atteint.' });
          continue;
        }
        if (err.invalideAdresse) {
          marquesObsoletes++;
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?id=eq.${encodeURIComponent(p.id)}`, {
            method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ bounced: true, bounce_reason: err.message }),
          });
        }
        resultats.push({ id: p.id, success: false, error: err.message });
      }
      await dormir(350); // évite de saturer le rate-limit Resend (comme prospects-send-email.js)
    }

    // 2. Combien reste-t-il, pour afficher une progression côté page.
    const restantsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?${filtre}&select=id`,
      { headers: { ...supaHeaders, Prefer: 'count=exact' } }
    );
    const contentRange = restantsResp.headers.get('content-range') || '';
    const matchTotal = contentRange.match(/\/(\d+)$/);
    const restants = matchTotal ? parseInt(matchTotal[1], 10) : null;

    return res.status(200).json({
      success: true,
      envoyes: resultats.filter((r) => r.success).length,
      echoues: resultats.filter((r) => !r.success).length,
      marquesObsoletes,
      quotaAtteint,
      restants,
      lot: idLot,
    });
  } catch (err) {
    console.error('prospection-send-batch error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Envoi impossible pour le moment.' });
  }
}
