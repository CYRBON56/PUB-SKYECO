// /api/dashboard-set-password.js
// Première création (ou réinitialisation directe par un admin) du mot de
// passe d'accès au tableau de bord d'un artisan. Utilisé par
// acces-dashboard.html quand aucun mot de passe n'existe encore pour ce
// site.
//
// Le mot de passe est celui du COMPTE (identifié par l'email), pas d'un
// site précis : s'il existe déjà d'autres vitrines sous le même email,
// elles reçoivent automatiquement le même mot de passe — un seul
// identifiant/mot de passe donne accès à toutes les vitrines d'un même
// artisan. Renvoie un jeton de session lié au compte (valable pour tous ses
// sites) pour connecter l'artisan sans repasser par l'écran de connexion.
//
// 12/09/2026 : accepte désormais un champ `email` optionnel dans le corps
// de la requête. Depuis que l'essai gratuit ne collecte plus l'email au
// départ (seulement le téléphone, vérifié par SMS — voir
// mon-dashboard-demo.html), le draft peut arriver ici SANS email déjà
// connu. acces-dashboard.html envoie alors l'email tapé par l'artisan sur
// cette page ; on l'enregistre sur le draft avant de créer le compte,
// sinon le token signé (et la propagation aux autres vitrines) se
// retrouvait construit avec un email vide, rendant toute connexion
// ultérieure impossible.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   DASHBOARD_SESSION_SECRET (chaîne aléatoire longue, à définir dans Vercel)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, ADMIN_PHONE
//
// 17/09/2026 (soir) : sur demande de Cyrille, un SMS lui est désormais
// envoyé à chaque première création de mot de passe (peu importe le point
// d'entrée — "Mettre en ligne", "Approvisionner", ou une première connexion
// depuis un lien direct — tous passent par ce même endpoint, appelé une
// seule fois par compte). Calqué sur le mécanisme déjà utilisé dans
// api/demander-formulaire-personnalise.js (même helper envoyerSMS).
// Best-effort : un échec d'envoi SMS ne doit jamais empêcher la création du
// compte de l'artisan.

import crypto from 'crypto';

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

function hasherMotDePasse(motDePasse) {
  const sel = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(motDePasse, sel, 64).toString('hex');
  return `${sel}:${hash}`;
}

function signerTokenCompte(email, dureeSecondes) {
  const exp = Math.floor(Date.now() / 1000) + dureeSecondes;
  const emailB64 = Buffer.from(String(email || '').trim().toLowerCase()).toString('base64url');
  const payload = `${emailB64}.artisan.${exp}`;
  const sig = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, motDePasse, email: emailFourni } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ success: false, error: 'draftId manquant' });
  }
  if (!motDePasse || typeof motDePasse !== 'string' || motDePasse.length < 8) {
    return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=id,email,entreprise,telephone,dashboard_password_hash`,
      { headers: supaHeaders }
    );
    const rows = await draftResp.json();
    const draft = rows[0];
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Site introuvable.' });
    }

    // Email à utiliser pour ce compte : celui déjà en base en priorité,
    // sinon celui fourni maintenant par l'artisan (cas d'un essai démarré
    // par téléphone seul, sans email connu jusqu'ici).
    const emailACompleter = !draft.email && emailFourni ? String(emailFourni).trim() : null;
    if (!draft.email && !emailFourni) {
      return res.status(400).json({ success: false, error: 'Email manquant.' });
    }
    const emailFinal = draft.email || emailACompleter;

    const hash = hasherMotDePasse(motDePasse);
    const maintenant = new Date().toISOString();

    const champsAPatcher = {
      dashboard_password_hash: hash,
      dashboard_compte_cree_le: maintenant,
      dashboard_reset_token: null,
      dashboard_reset_token_expire: null,
    };
    if (emailACompleter) champsAPatcher.email = emailACompleter;

    const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify(champsAPatcher),
    });
    if (!patchResp.ok) throw new Error("Échec de l'enregistrement du mot de passe.");

    // Propage le même mot de passe aux autres vitrines du même artisan
    // (même email) : un seul identifiant/mot de passe pour tout le compte.
    // Best-effort — une erreur ici ne doit pas bloquer la création du tout
    // premier accès.
    if (emailFinal) {
      try {
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?email=ilike.${encodeURIComponent(emailFinal)}&id=neq.${draftId}`,
          {
            method: 'PATCH',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ dashboard_password_hash: hash }),
          }
        );
      } catch (e) {
        console.error('Propagation mot de passe aux autres sites échouée (non bloquant) :', e);
      }
    }

    // SMS à Cyrille — uniquement sur une VRAIE première création (pas une
    // réinitialisation), pour ne pas le notifier à chaque reset de mot de
    // passe qu'il ferait lui-même depuis mes-artisans.html. Best-effort :
    // ne bloque jamais la réponse de succès envoyée à l'artisan.
    const estPremiereCreation = !draft.dashboard_password_hash;
    if (estPremiereCreation) {
      const nomAffiche = draft.entreprise || 'Un artisan';
      const coordonnees = [draft.telephone, emailFinal].filter(Boolean).join(' — ');
      const lienDashboard = `https://www.skyeco.fr/mon-dashboard.html?id=${draftId}`;
      const texte = `🔔 ${nomAffiche} vient de créer son mot de passe et d'accéder à son tableau de bord Skyeco Pro pour la première fois.${coordonnees ? ' Contact : ' + coordonnees + '.' : ''} Dashboard : ${lienDashboard}`;
      try {
        await envoyerSMS(ADMIN_PHONE, texte);
      } catch (e) {
        console.error('Échec envoi SMS dashboard-set-password (non bloquant) :', e);
      }
    }

    const token = signerTokenCompte(emailFinal, 60 * 60 * 24 * 30); // 30 jours
    return res.status(200).json({ success: true, token });
  } catch (err) {
    console.error('Erreur dashboard-set-password :', err);
    return res.status(500).json({ success: false, error: "Impossible d'enregistrer votre mot de passe pour le moment." });
  }
}
