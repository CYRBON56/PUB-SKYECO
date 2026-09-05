// api/appeler-artisan-maintenant.js
//
// POST /api/appeler-artisan-maintenant   body: { draftId }
//
// Appel vidéo immédiat déclenché par Cyrille depuis mes-artisans.html,
// typiquement quand la pastille "en ligne" (voir api/ping-presence.js)
// montre qu'un artisan a son dashboard ouvert en ce moment. Contrairement au
// flux "demande d'appel" (prendre-rdv.html -> api/reserver-creneau.js), il
// n'y a ici ni créneau à choisir ni validation : la ligne est créée
// directement en statut "en_cours" et l'artisan est prévenu tout de suite.
//
// Même modèle de sécurité que les autres actions de mes-artisans.html
// (envoyer-lien-elements.js, etc.) : pas de mot de passe requis ici, la page
// elle-même n'étant accessible qu'à qui en connaît l'URL.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// RESEND_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_FROM_NUMBER

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 05/09 : fetch direct vers l'API Resend, pas le paquet npm "resend" (jamais
// dans package.json — voir api/reserver-creneau.js pour le détail du bug).
const RESEND_FROM = 'Skyeco Pro <notifications@ecoskybyrms.fr>';
async function envoyerEmailResend({ to, subject, html }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!resp.ok) throw new Error(`Resend a répondu ${resp.status} : ${await resp.text()}`);
}

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Fiche interne "Skyeco Pro" (Cyrille lui-même) — même identifiant que celui
// déjà utilisé côté front dans mes-artisans.html/mon-dashboard.html pour son
// propre calendrier admin.
const DRAFT_ID_SKYECO_PRO = '4fbdb122-9fca-4636-b80c-d9e4abc2542b';

function toE164(numero) {
  if (!numero) return null;
  let n = String(numero).trim().replace(/[\s.\-()]/g, '');
  if (n.startsWith('+')) return n;
  if (n.startsWith('0')) return '+33' + n.slice(1);
  if (n.startsWith('33')) return '+' + n;
  return n;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'methode_non_autorisee' });
  }

  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ error: 'champs_manquants' });
  }

  try {
    const { data: artisan, error: erreurLecture } = await supabase
      .from('skyeco_pro_vitrine_drafts')
      .select('entreprise, telephone, email')
      .eq('id', draftId)
      .single();

    if (erreurLecture || !artisan) {
      return res.status(404).json({ error: 'artisan_introuvable' });
    }

    const roomName = 'skyeco-' + crypto.randomBytes(8).toString('hex');
    const maintenant = new Date();

    const { error: erreurInsert } = await supabase
      .from('rendez_vous_artisans')
      .insert({
        draft_id: DRAFT_ID_SKYECO_PRO,
        date_heure: maintenant.toISOString(),
        statut: 'confirme',
        type_rdv: 'appel_video_artisan',
        draft_id_demandeur: draftId,
        room_name: roomName,
        appel_statut: 'en_cours',
        appel_demarre_le: maintenant.toISOString(),
        client_nom: artisan.entreprise || 'Artisan',
        client_telephone: artisan.telephone || null,
        client_email: artisan.email || null,
        client_message: 'Appel déclenché directement par Cyrille (artisan détecté en ligne).',
      });

    if (erreurInsert) {
      console.error('appeler-artisan-maintenant: erreur insert', erreurInsert);
      return res.status(500).json({ error: 'erreur_serveur' });
    }

    const roomUrl = `https://meet.jit.si/${roomName}`;

    const notifs = [];
    if (twilioClient && artisan.telephone && process.env.TWILIO_FROM_NUMBER) {
      notifs.push(
        twilioClient.messages.create({
          to: toE164(artisan.telephone),
          from: process.env.TWILIO_FROM_NUMBER,
          body: `Cyrille vous appelle maintenant en visio : ${roomUrl}`,
        }).catch((e) => console.error('SMS artisan (appel immédiat) échoué:', e.message))
      );
    }
    if (process.env.RESEND_API_KEY && artisan.email) {
      notifs.push(
        envoyerEmailResend({
          to: artisan.email,
          subject: 'Cyrille vous appelle maintenant',
          html: `<p>Bonjour,</p><p>Cyrille vous appelle en visio dès maintenant :</p><p><a href="${roomUrl}">${roomUrl}</a></p>`,
        }).catch((e) => console.error('Email artisan (appel immédiat) échoué:', e.message))
      );
    }
    await Promise.allSettled(notifs);

    return res.status(200).json({ success: true, roomUrl });
  } catch (e) {
    console.error('appeler-artisan-maintenant: erreur inattendue', e);
    return res.status(500).json({ error: 'erreur_serveur' });
  }
}
