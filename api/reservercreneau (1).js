// api/reserver-creneau.js
//
// POST /api/reserver-creneau
// Body JSON: { draft_id, date_heure (ISO renvoyé par creneaux-disponibles),
//              client_nom, client_telephone, client_email?, client_message? }
//
// Réserve un créneau de façon atomique (protégé par l'index unique SQL contre
// le double-booking), puis notifie l'artisan (SMS + email) et confirme au
// client (email si fourni). Endpoint public (n'importe quel client final
// doit pouvoir réserver).
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// RESEND_API_KEY, RESEND_FROM_EMAIL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_FROM_NUMBER — vérifie que ces noms correspondent à ceux déjà
// configurés sur le projet Vercel PUB-SKYECO (adapte sinon).

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

const FUSEAU = 'Europe/Paris';
const HEURE_OUVERTURE = 9;
const HEURE_FERMETURE = 20;
const JOURS_FERMES = [0]; // dimanche

// --- toE164 : même logique que le reste du projet (idempotente) -----------
function toE164(numero) {
  if (!numero) return null;
  let n = String(numero).trim().replace(/[\s.\-()]/g, '');
  if (n.startsWith('+')) return n;
  if (n.startsWith('0')) return '+33' + n.slice(1);
  if (n.startsWith('33')) return '+' + n;
  return n;
}

function decalageMinutes(dateUTC, fuseau) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: fuseau, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(dateUTC).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  const heure = p.hour === '24' ? '00' : p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +heure, +p.minute, +p.second);
  return { asUTC, decal: (asUTC - dateUTC.getTime()) / 60000 };
}

// Vérifie que date_heure tombe bien sur un créneau valide : heure pile,
// dans la plage 9h-20h, un jour ouvert (lundi-samedi), et dans le futur.
function creneauValide(dateUTC) {
  if (Number.isNaN(dateUTC.getTime())) return false;
  if (dateUTC.getTime() <= Date.now()) return false;
  const { asUTC } = decalageMinutes(dateUTC, FUSEAU);
  const local = new Date(asUTC);
  const jourSemaine = local.getUTCDay();
  const heure = local.getUTCHours();
  const minute = local.getUTCMinutes();
  if (JOURS_FERMES.includes(jourSemaine)) return false;
  if (minute !== 0) return false;
  if (heure < HEURE_OUVERTURE || heure >= HEURE_FERMETURE) return false;
  return true;
}

function formatDateHeureFr(dateUTC) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: FUSEAU, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  }).format(dateUTC);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'methode_non_autorisee' });
  }

  try {
    const { draft_id, date_heure, client_nom, client_telephone, client_email, client_message } = req.body || {};

    if (!draft_id || !date_heure || !client_nom || !client_telephone) {
      return res.status(400).json({ error: 'champs_manquants', message: 'draft_id, date_heure, client_nom et client_telephone sont requis.' });
    }

    const dateUTC = new Date(date_heure);
    if (!creneauValide(dateUTC)) {
      return res.status(400).json({ error: 'creneau_invalide', message: 'Ce créneau n\'est pas valide (hors horaires, jour fermé ou déjà passé).' });
    }

    // Réservation atomique : l'index unique SQL (draft_id, date_heure) fait
    // le vrai travail anti double-booking, même en cas de requêtes simultanées.
    const { data: rdv, error: insertError } = await supabase
      .from('rendez_vous_artisans')
      .insert({
        draft_id,
        date_heure: dateUTC.toISOString(),
        statut: 'confirme',
        client_nom,
        client_telephone,
        client_email: client_email || null,
        client_message: client_message || null,
      })
      .select()
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        return res.status(409).json({ error: 'creneau_deja_pris', message: 'Ce créneau vient d\'être pris à l\'instant, merci d\'en choisir un autre.' });
      }
      console.error('reserver-creneau: erreur insert', insertError);
      return res.status(500).json({ error: 'erreur_serveur' });
    }

    // Récupère les coordonnées de l'artisan pour la notification
    const { data: artisan } = await supabase
      .from('skyeco_pro_vitrine_drafts')
      .select('entreprise, telephone, email')
      .eq('id', draft_id)
      .single();

    const nomArtisan = artisan?.entreprise || 'votre artisan';
    const dateFr = formatDateHeureFr(dateUTC);

    // --- Notifications : best-effort, ne bloquent jamais la réponse ---------
    const notifs = [];

    if (twilioClient && artisan?.telephone && process.env.TWILIO_FROM_NUMBER) {
      const texte = `Nouveau RDV le ${dateFr} avec ${client_nom} (${client_telephone}).`;
      notifs.push(
        twilioClient.messages.create({
          to: toE164(artisan.telephone),
          from: process.env.TWILIO_FROM_NUMBER,
          body: texte,
        }).catch((e) => console.error('SMS artisan échoué:', e.message))
      );
    }

    if (resend && artisan?.email) {
      notifs.push(
        resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL,
          to: artisan.email,
          subject: `Nouveau RDV le ${dateFr}`,
          html: `<p>Nouveau rendez-vous pris :</p>
                 <p><strong>${dateFr}</strong></p>
                 <p>Client : ${client_nom}<br>Téléphone : ${client_telephone}${client_email ? `<br>Email : ${client_email}` : ''}</p>
                 ${client_message ? `<p>Message : ${client_message}</p>` : ''}`,
        }).catch((e) => console.error('Email artisan échoué:', e.message))
      );
    }

    if (resend && client_email) {
      notifs.push(
        resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL,
          to: client_email,
          subject: `Votre RDV confirmé — ${dateFr}`,
          html: `<p>Bonjour ${client_nom},</p>
                 <p>Votre rendez-vous avec <strong>${nomArtisan}</strong> est confirmé :</p>
                 <p><strong>${dateFr}</strong></p>
                 <p>À bientôt.</p>`,
        }).catch((e) => console.error('Email client échoué:', e.message))
      );
    }

    await Promise.allSettled(notifs);

    return res.status(200).json({
      ok: true,
      rdv: { id: rdv.id, date_heure: rdv.date_heure, date_heure_fr: dateFr },
    });
  } catch (e) {
    console.error('reserver-creneau: erreur inattendue', e);
    return res.status(500).json({ error: 'erreur_serveur' });
  }
}
