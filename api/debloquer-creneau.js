// api/debloquer-creneau.js
//
// POST /api/debloquer-creneau   body: { draftId, token, date_heure }
//
// Libère un créneau précédemment bloqué par l'artisan (statut 'indisponible'
// uniquement). Ne touche JAMAIS une ligne 'confirme' : impossible d'annuler
// un vrai RDV client depuis cet endpoint, par sécurité.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// DASHBOARD_SESSION_SECRET

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Vérification de session : identique à api/dashboard-verify-session.js
function verifierToken(token, draftIdAttendu) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return null;
    const [draftId, role, expStr, sig] = parties;
    if (draftId !== draftIdAttendu) return null;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return null;

    const payload = `${draftId}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return null;

    return { draftId, role };
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'methode_non_autorisee' });
  }

  const { draftId, token, date_heure } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ error: 'non_authentifie' });
  }
  if (!verifierToken(token, draftId)) {
    return res.status(401).json({ error: 'session_invalide' });
  }

  const d = new Date(date_heure);
  if (!date_heure || Number.isNaN(d.getTime())) {
    return res.status(400).json({ error: 'date_invalide' });
  }

  // On ne supprime que si la ligne appartient bien à cet artisan ET est un
  // blocage manuel (jamais un RDV confirmé).
  const { data, error } = await supabase
    .from('rendez_vous_artisans')
    .delete()
    .eq('draft_id', draftId)
    .eq('date_heure', d.toISOString())
    .eq('statut', 'indisponible')
    .select();

  if (error) {
    console.error('debloquer-creneau: erreur delete', error);
    return res.status(500).json({ error: 'erreur_serveur' });
  }

  if (!data || data.length === 0) {
    return res.status(404).json({ error: 'rien_a_debloquer', message: 'Ce créneau n\'était pas bloqué (ou est un RDV confirmé).' });
  }

  return res.status(200).json({ ok: true });
}
