// api/envoyer-message-artisan.js
//
// POST /api/envoyer-message-artisan   body: { motDePasseInterne, draftId, message }
//
// Permet à Cyrille d'envoyer un message ciblé à un artisan qui a un problème
// (demande faite le 07/09/2026) : SMS immédiat (via Twilio, comme le reste
// du projet) ET trace posée dans son dashboard (table
// skyeco_pro_messages_admin, lue par mon-dashboard.html via
// api/messages-artisan.js), pour qu'il retrouve le message même s'il rate le
// SMS. Protégé par le même mot de passe interne que api/mes-artisans.js.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// INTERNAL_ACCESS_PASSWORD, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Même logique que le reste du projet (idempotente).
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
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { motDePasseInterne, draftId, message } = req.body || {};

  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }
  if (!draftId || !message || !message.trim()) {
    return res.status(400).json({ success: false, error: 'draftId et message sont requis.' });
  }

  try {
    const { data: draft, error: errDraft } = await supabase
      .from('skyeco_pro_vitrine_drafts')
      .select('entreprise, telephone')
      .eq('id', draftId)
      .single();
    if (errDraft || !draft) {
      return res.status(404).json({ success: false, error: 'Artisan introuvable.' });
    }

    const contenu = message.trim();
    let smsEnvoye = false;

    if (twilioClient && draft.telephone && process.env.TWILIO_FROM_NUMBER) {
      try {
        await twilioClient.messages.create({
          to: toE164(draft.telephone),
          from: process.env.TWILIO_FROM_NUMBER,
          body: `Skyeco Pro — message de Cyrille :\n${contenu}`,
        });
        smsEnvoye = true;
      } catch (e) {
        console.error('envoyer-message-artisan: échec envoi SMS', e.message);
      }
    }

    const { error: errInsert } = await supabase
      .from('skyeco_pro_messages_admin')
      .insert({ draft_id: draftId, contenu });
    if (errInsert) throw errInsert;

    return res.status(200).json({ success: true, smsEnvoye, telephoneManquant: !draft.telephone });
  } catch (err) {
    console.error('Erreur envoyer-message-artisan :', err);
    return res.status(500).json({ success: false, error: "Impossible d'envoyer le message pour le moment." });
  }
}
