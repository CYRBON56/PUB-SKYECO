// api/rappel-rdv.js
//
// Tâche planifiée (Vercel Cron, voir vercel.json) qui envoie un rappel SMS
// 2h avant chaque rendez-vous confirmé (module de RDV interne — voir
// api/reserver-creneau.js) : un SMS au client ET un SMS à l'artisan.
//
// Logique volontairement simple plutôt qu'une fenêtre exacte "entre 1h55 et
// 2h05" : à chaque passage (toutes les 15 min), on rappelle TOUT rendez-vous
// confirmé qui tombe dans les 2 prochaines heures et qui n'a pas encore reçu
// son rappel (colonne rappel_envoye, migration ajout_rappel_rdv_envoye du
// 04/09). Un RDV pris moins de 2h à l'avance reçoit donc son rappel dès le
// prochain passage du cron, immédiatement plutôt que jamais — c'est le
// comportement voulu (mieux vaut un rappel un peu en avance/en retard que
// pas de rappel du tout).
//
// Configuration requise dans vercel.json :
//   { "path": "/api/rappel-rdv", "schedule": "*/15 * * * *" }
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, CRON_SECRET

import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const FUSEAU = 'Europe/Paris';
const FENETRE_RAPPEL_MS = 2 * 60 * 60 * 1000; // 2h avant le RDV

// --- toE164 : même logique que le reste du projet (idempotente) -----------
function toE164(numero) {
  if (!numero) return null;
  let n = String(numero).trim().replace(/[\s.\-()]/g, '');
  if (n.startsWith('+')) return n;
  if (n.startsWith('0')) return '+33' + n.slice(1);
  if (n.startsWith('33')) return '+' + n;
  return n;
}

function formatHeureFr(dateUTC) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: FUSEAU, weekday: 'long', hour: '2-digit', minute: '2-digit',
  }).format(dateUTC);
}

async function envoyerSMS(to, body) {
  if (!twilioClient || !to || !process.env.TWILIO_FROM_NUMBER) return false;
  try {
    await twilioClient.messages.create({
      to: toE164(to),
      from: process.env.TWILIO_FROM_NUMBER,
      body,
    });
    return true;
  } catch (e) {
    console.error('rappel-rdv: échec envoi SMS', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'non_autorise' });
  }

  try {
    const maintenant = new Date();
    const limite = new Date(maintenant.getTime() + FENETRE_RAPPEL_MS);

    const { data: rdvs, error } = await supabase
      .from('rendez_vous_artisans')
      .select('id, draft_id, date_heure, client_nom, client_telephone')
      .eq('statut', 'confirme')
      .eq('rappel_envoye', false)
      .gt('date_heure', maintenant.toISOString())
      .lte('date_heure', limite.toISOString());

    if (error) {
      console.error('rappel-rdv: erreur lecture rendez_vous_artisans', error);
      return res.status(500).json({ error: 'erreur_serveur' });
    }

    const resultats = [];

    for (const rdv of rdvs || []) {
      try {
        const { data: artisan } = await supabase
          .from('skyeco_pro_vitrine_drafts')
          .select('entreprise, telephone')
          .eq('id', rdv.draft_id)
          .single();

        const heureFr = formatHeureFr(new Date(rdv.date_heure));
        const nomArtisan = artisan?.entreprise || 'votre artisan';

        const smsClient = await envoyerSMS(
          rdv.client_telephone,
          `Rappel : votre RDV avec ${nomArtisan} est prévu ${heureFr}.`
        );
        const smsArtisan = await envoyerSMS(
          artisan?.telephone,
          `Rappel : RDV avec ${rdv.client_nom || 'un client'} ${heureFr}.`
        );

        // Marqué comme envoyé dès qu'on a essayé (best-effort, comme le
        // reste des notifications de ce module) : on ne veut pas relancer un
        // rappel en boucle à chaque passage du cron si un envoi échoue une
        // fois (numéro invalide, Twilio en erreur...).
        await supabase
          .from('rendez_vous_artisans')
          .update({ rappel_envoye: true })
          .eq('id', rdv.id);

        resultats.push({ id: rdv.id, smsClient, smsArtisan });
      } catch (err) {
        console.error('rappel-rdv: erreur traitement RDV', rdv.id, err);
      }
    }

    return res.status(200).json({ success: true, rappelsEnvoyes: resultats.length, details: resultats });
  } catch (err) {
    console.error('rappel-rdv: erreur inattendue', err);
    return res.status(500).json({ error: 'erreur_serveur' });
  }
}
