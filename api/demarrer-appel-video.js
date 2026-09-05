// api/demarrer-appel-video.js
//
// POST /api/demarrer-appel-video   body: { draftId, token, rdvId }
//
// Appelé par mon-dashboard.html (calendrier de Cyrille, DRAFT_ID_SKYECO_PRO
// uniquement) quand Cyrille clique "🎥 Démarrer l'appel" sur une demande
// d'appel vidéo validée (voir afficherJoursCalendrier). Marque le rendez-vous
// comme "en_cours", prévient l'artisan demandeur par SMS + email avec le lien
// de la salle Jitsi, et renvoie ce même lien pour que Cyrille l'ouvre
// immédiatement de son côté.
//
// Réservé au jeton admin (mes-artisans.html -> dashboard-admin-token.js) :
// démarrer un appel déclenche une notification réelle vers un artisan, pas
// une simple lecture.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// DASHBOARD_SESSION_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL,
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import twilio from 'twilio';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

function toE164(numero) {
  if (!numero) return null;
  let n = String(numero).trim().replace(/[\s.\-()]/g, '');
  if (n.startsWith('+')) return n;
  if (n.startsWith('0')) return '+33' + n.slice(1);
  if (n.startsWith('33')) return '+' + n;
  return n;
}

// Même vérification que dashboard-verify-session.js, mais réservée au rôle
// admin : seul Cyrille (via mes-artisans.html) doit pouvoir démarrer un
// appel et déclencher une notification vers un artisan.
function verifierJetonAdmin(token, draftIdAttendu) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return false;
    const [sujet, role, expStr, sig] = parties;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return false;
    if (role !== 'admin' || sujet !== draftIdAttendu) return false;

    const payload = `${sujet}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    return sigBuf.length === attenduBuf.length && crypto.timingSafeEqual(sigBuf, attenduBuf);
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'methode_non_autorisee' });
  }

  const { draftId, token, rdvId } = req.body || {};
  if (!draftId || !token || !rdvId) {
    return res.status(400).json({ error: 'champs_manquants' });
  }
  if (!verifierJetonAdmin(token, draftId)) {
    return res.status(401).json({ error: 'non_autorise' });
  }

  try {
    const { data: rdv, error: erreurLecture } = await supabase
      .from('rendez_vous_artisans')
      .select('id, draft_id, draft_id_demandeur, type_rdv, room_name, appel_statut')
      .eq('id', rdvId)
      .single();

    if (erreurLecture || !rdv || rdv.draft_id !== draftId || rdv.type_rdv !== 'appel_video_artisan') {
      return res.status(404).json({ error: 'appel_introuvable' });
    }
    if (rdv.appel_statut === 'termine') {
      return res.status(409).json({ error: 'appel_deja_termine' });
    }

    await supabase
      .from('rendez_vous_artisans')
      .update({ appel_statut: 'en_cours', appel_demarre_le: new Date().toISOString() })
      .eq('id', rdvId);

    const roomUrl = `https://meet.jit.si/${rdv.room_name}`;

    if (rdv.draft_id_demandeur) {
      const { data: artisan } = await supabase
        .from('skyeco_pro_vitrine_drafts')
        .select('telephone, email, entreprise')
        .eq('id', rdv.draft_id_demandeur)
        .single();

      const notifs = [];
      if (twilioClient && artisan?.telephone && process.env.TWILIO_FROM_NUMBER) {
        notifs.push(
          twilioClient.messages.create({
            to: toE164(artisan.telephone),
            from: process.env.TWILIO_FROM_NUMBER,
            body: `Cyrille vous appelle maintenant en visio : ${roomUrl}`,
          }).catch((e) => console.error('SMS artisan (démarrage appel) échoué:', e.message))
        );
      }
      if (resend && artisan?.email) {
        notifs.push(
          resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL,
            to: artisan.email,
            subject: 'Cyrille vous appelle maintenant',
            html: `<p>Bonjour,</p><p>Cyrille vous appelle en visio dès maintenant :</p><p><a href="${roomUrl}">${roomUrl}</a></p>`,
          }).catch((e) => console.error('Email artisan (démarrage appel) échoué:', e.message))
        );
      }
      await Promise.allSettled(notifs);
    }

    return res.status(200).json({ success: true, roomUrl });
  } catch (e) {
    console.error('demarrer-appel-video: erreur inattendue', e);
    return res.status(500).json({ error: 'erreur_serveur' });
  }
}
