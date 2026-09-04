// /api/notify-nouvelle-demande.js
//
// Reçoit la demande d'un prospect depuis apercu.html, l'enregistre dans
// Supabase, PUIS envoie la double notification :
//   - Au PROSPECT : SMS + email confirmant que son estimation arrive
//   - À l'ARTISAN : SMS + email l'informant d'une nouvelle demande
//
// C'est la fondation technique de l'abonnement Skyeco Pro (79,90€/mois) —
// sans cet endpoint, personne ne recevait de notification, seule la ligne
// était enregistrée en base.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   ADMIN_PHONE (déjà configuré sur Vercel — utilisé aussi par
//   demander-aide-elements.js — sert d'alerte de secours ci-dessous)

const RESEND_FROM = 'Skyeco Pro <notifications@ecoskybyrms.fr>';
// Filet de sécurité (04/09) : un incident du 31/08 au 04/09 (clé Resend
// invalidée côté Vercel) a fait échouer TOUS les envois d'email de cet
// endpoint pendant plusieurs jours sans que personne ne le remarque — les
// SMS continuaient de partir normalement, donc rien ne semblait cassé côté
// artisan/prospect, et l'erreur ne vivait que dans les logs Vercel
// (jamais consultés en temps normal). Pour ne plus dépendre d'y penser :
// dès qu'un envoi (SMS ou email, prospect ou artisan) échoue réellement
// (pas juste "skipped" faute de coordonnées), un SMS d'alerte part vers
// Cyrille (ADMIN_PHONE) — canal Twilio, indépendant de Resend, donc qui
// continue de fonctionner même quand c'est Resend qui casse.
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

// Twilio exige un numero au format E.164 (+33...) pour le parametre "To" des
// SMS envoyes via l'API Messages (contrairement a Twilio Verify, deja converti
// ailleurs). Les numeros stockes en base viennent du formulaire d'inscription
// au format national francais ("06 12 34 56 78"), jamais convertis avant ces
// envois -> Twilio les rejetait silencieusement (erreur 21211, capturee par le
// try/catch), d'ou les echecs d'envoi. Idempotent : ne change rien a un numero
// deja au format E.164.
function toE164(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+33' + digits.slice(1);
  return rawPhone;
}

async function envoyerSMS(to, body, fromOverride) {
  if (!to) return { skipped: true, reason: 'numéro manquant' };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = fromOverride || process.env.TWILIO_FROM_NUMBER; // numéro dédié à l'artisan si disponible, sinon numéro partagé
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('Erreur envoi SMS Twilio :', JSON.stringify(data));
    return { success: false, error: data.message };
  }
  return { success: true, sid: data.sid };
}

function echapperHtml(valeur) {
  return String(valeur)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Construit un récapitulatif HTML (produit, quantité, réponses, montant) à
// partir du tableau optionnel "recap" envoyé par apercu.html — uniquement
// rempli quand le projet du prospect a pu être chiffré automatiquement (voir
// api/classifier-projet-formulaire.js). Sans "recap" (projet non chiffrable,
// ou ancien appelant), renvoie une chaîne vide et l'email garde son texte
// minimal habituel.
function construireRecapHtml(recap) {
  if (!Array.isArray(recap) || !recap.length) return '';
  const lignes = recap
    .filter(r => r && r.label && r.valeur !== undefined && r.valeur !== null && r.valeur !== '')
    .map(r => `<li><strong>${echapperHtml(r.label)}</strong> : ${echapperHtml(r.valeur)}</li>`)
    .join('');
  if (!lignes) return '';
  return `<p><strong>Récapitulatif de la demande :</strong></p><ul style="margin:6px 0 14px; padding-left:20px; line-height:1.7;">${lignes}</ul>`;
}

async function envoyerEmail(to, subject, html) {
  if (!to) return { skipped: true, reason: 'email manquant' };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('Erreur envoi email Resend :', JSON.stringify(data));
    return { success: false, error: data.message };
  }
  return { success: true, id: data.id };
}

// Un résultat Promise.allSettled compte comme un échec RÉEL seulement s'il a
// explicitement échoué (rejeté, ou { success:false }) — pas s'il a juste été
// "skipped" faute de numéro/email (ça, c'est normal, pas une panne).
function estEchecReel(resultatSettled) {
  if (resultatSettled.status === 'rejected') return true;
  const v = resultatSettled.value;
  return !!v && v.success === false;
}

// Best-effort, ne doit jamais faire planter la requête principale : si même
// ce SMS d'alerte échoue (Twilio down en plus de Resend, cas extrême), on se
// contente de logger, la réponse au navigateur part quand même normalement.
async function alerterAdminSiEchecs(echecs, contexte) {
  if (!echecs.length || !ADMIN_PHONE) return;
  try {
    const texte = `⚠️ Skyeco Pro — échec d'envoi (${echecs.join(', ')}) pour la demande de ${contexte.prenomAffiche} ${contexte.nom || ''} sur "${contexte.nomEntreprise}". Vérifie RESEND_API_KEY / Twilio sur Vercel (projet pub-skyeco-23ue).`;
    const resultat = await envoyerSMS(ADMIN_PHONE, texte);
    if (resultat && resultat.success === false) {
      console.error('Alerte admin (échec notif) elle-même non délivrée :', JSON.stringify(resultat));
    }
  } catch (err) {
    console.error('Erreur envoi alerte admin (échec notif) :', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { draftId, nom, prenom, telephone, telephoneVerifie, email, reponses, recap, estimationTexte } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ error: 'draftId manquant' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Récupère les infos de l'artisan (téléphone/email/entreprise) via le brouillon.
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,telephone,email,metier,twilio_phone_number`,
      { headers: supaHeaders }
    );
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];
    if (!draft) {
      return res.status(404).json({ error: 'Site introuvable pour cette demande.' });
    }

    // 2. Enregistre le lead (même logique que l'ancien insert client-side, mais côté serveur).
    const insertResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads`, {
      method: 'POST',
      headers: { ...supaHeaders, Prefer: 'return=representation' },
      body: JSON.stringify([{
        draft_id: draftId,
        nom: nom || null,
        prenom: prenom || null,
        telephone: telephone || null,
        telephone_verifie: !!telephoneVerifie,
        email: email || null,
        // Le récap détaillé (produit/quantité/réponses/montant), quand présent,
        // est conservé dans "reponses" (jsonb) pour rester visible depuis le
        // dashboard artisan, en plus d'être inclus dans les emails ci-dessous.
        reponses: Array.isArray(recap) && recap.length ? { ...(reponses || {}), recap } : (reponses || {}),
        statut: 'nouveau',
      }]),
    });
    if (!insertResp.ok) {
      const errData = await insertResp.json().catch(() => ({}));
      console.error('Erreur insertion lead :', JSON.stringify(errData));
      return res.status(500).json({ error: "Votre demande n'a pas pu être enregistrée." });
    }
    // Bug pré-existant corrigé (02/09) : la réponse de l'insertion n'était
    // jamais lue, donc leadId n'était jamais réellement transmis au client
    // malgré Prefer:return=representation déjà posé — apercu.html s'appuie
    // dessus (ex: bouton "Envoyer mes photos par SMS").
    const insertData = await insertResp.json().catch(() => []);
    const leadId = insertData[0]?.id || null;
    // 3. Double notification — en parallèle, on continue même si l'un des envois échoue.
    const prenomAffiche = prenom || 'Bonjour';
    const nomEntreprise = draft.entreprise || 'votre artisan';
    const numeroExpediteur = draft.twilio_phone_number || null; // repli automatique sur TWILIO_FROM_NUMBER si absent
    const recapHtml = construireRecapHtml(recap); // vide si pas de recap (projet non chiffrable, ou appelant plus ancien)
    // Quand le projet a pu être chiffré (voir apercu.html, calculerEstimation),
    // le SMS ET l'email au prospect contiennent directement le montant —
    // pas seulement un accusé de réception générique. Sans estimation
    // (projet non chiffrable, ou appelant plus ancien sans ce champ), le
    // message générique habituel reste inchangé.
    const smsProspectBody = estimationTexte
      ? `${prenomAffiche}, voici votre estimation ${nomEntreprise} : ${estimationTexte} Un conseiller vous recontacte sous 24h pour la confirmer.`
      : `${prenomAffiche}, votre demande d'estimation aupres de ${nomEntreprise} est bien recue. Un conseiller vous recontacte sous 24h.`;
    const estimationTexteHtml = estimationTexte
      ? `<p style="font-size:15px; font-weight:600; color:#14312a;">${echapperHtml(estimationTexte)}</p>`
      : '';

    const [smsProspect, emailProspect, smsArtisan, emailArtisan] = await Promise.allSettled([
      envoyerSMS(telephone, smsProspectBody, numeroExpediteur),
      envoyerEmail(
        email,
        `Votre estimation ${nomEntreprise} est en cours`,
        `<p>Bonjour ${prenomAffiche},</p><p>Votre demande d'estimation auprès de <strong>${nomEntreprise}</strong> a bien été enregistrée.</p>${estimationTexteHtml}${recapHtml}<p>Un conseiller vous recontacte sous 24h pour affiner votre projet.</p>`
      ),
      envoyerSMS(
        draft.telephone,
        `Nouvelle demande recue sur votre vitrine Skyeco Pro : ${prenomAffiche} ${nom || ''}. Consultez votre tableau de bord pour le rappeler.`,
        numeroExpediteur
      ),
      envoyerEmail(
        draft.email,
        'Nouvelle demande reçue sur votre vitrine Skyeco Pro',
        `<p>Bonjour,</p><p>Vous avez reçu une nouvelle demande de la part de <strong>${prenomAffiche} ${nom || ''}</strong>.</p><p>Téléphone : ${telephone || 'non fourni'}<br>Email : ${email || 'non fourni'}</p>${recapHtml}<p>Pensez à le rappeler rapidement pour transformer cette demande en client.</p>`
      ),
    ]);

    // Filet de sécurité (voir commentaire sur alerterAdminSiEchecs) : un
    // résumé des vrais échecs (pas les "skipped") déclenche une alerte SMS
    // à Cyrille, en plus de la réponse normale au navigateur — jamais
    // bloquant, jamais visible du prospect/artisan.
    const echecs = [];
    if (estEchecReel(smsProspect)) echecs.push('SMS prospect');
    if (estEchecReel(emailProspect)) echecs.push('email prospect');
    if (estEchecReel(smsArtisan)) echecs.push('SMS artisan');
    if (estEchecReel(emailArtisan)) echecs.push('email artisan');
    await alerterAdminSiEchecs(echecs, { prenomAffiche, nom, nomEntreprise });

    return res.status(200).json({
      success: true,
      leadId,
      notifications: {
        smsProspect: smsProspect.status === 'fulfilled' ? smsProspect.value : { success: false },
        emailProspect: emailProspect.status === 'fulfilled' ? emailProspect.value : { success: false },
        smsArtisan: smsArtisan.status === 'fulfilled' ? smsArtisan.value : { success: false },
        emailArtisan: emailArtisan.status === 'fulfilled' ? emailArtisan.value : { success: false },
      },
    });
  } catch (err) {
    console.error('Erreur notify-nouvelle-demande :', err);
    return res.status(500).json({ error: "Une erreur est survenue lors de l'enregistrement." });
  }
}
