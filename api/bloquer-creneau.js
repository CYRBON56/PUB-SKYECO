// api/bloquer-creneau.js
//
// POST /api/bloquer-creneau
//   body: { draftId, token, date_heure }
//   body: { draftId, token, date_heure_debut, date_heure_fin }  (bloc de plusieurs créneaux, ex: une journée)
//
// Marque un ou plusieurs créneaux comme 'indisponible' pour L'ARTISAN CONNECTÉ
// (vacances, jour off...). N'affecte jamais un créneau déjà 'confirme' (un
// vrai RDV client) : la tentative échoue simplement (créneau déjà occupé).
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

  const { draftId, token, date_heure, date_heure_debut, date_heure_fin } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ error: 'non_authentifie' });
  }
  if (!verifierToken(token, draftId)) {
    return res.status(401).json({ error: 'session_invalide' });
  }

  let datesAbloquer = [];
  if (date_heure) {
    const d = new Date(date_heure);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'date_invalide' });
    datesAbloquer = [d];
  } else if (date_heure_debut && date_heure_fin) {
    const debut = new Date(date_heure_debut);
    const fin = new Date(date_heure_fin);
    if (Number.isNaN(debut.getTime()) || Number.isNaN(fin.getTime()) || fin < debut) {
      return res.status(400).json({ error: 'plage_invalide' });
    }
    // Génère un créneau par heure entre début et fin inclus (bloc de jour par ex.)
    for (let t = debut.getTime(); t <= fin.getTime(); t += 3600 * 1000) {
      datesAbloquer.push(new Date(t));
    }
  } else {
    return res.status(400).json({ error: 'champs_manquants', message: 'date_heure, ou date_heure_debut + date_heure_fin.' });
  }

  const resultats = [];
  for (const d of datesAbloquer) {
    const { error } = await supabase
      .from('rendez_vous_artisans')
      .insert({ draft_id: draftId, date_heure: d.toISOString(), statut: 'indisponible' });

    if (error && error.code !== '23505') {
      console.error('bloquer-creneau: erreur insert', error);
      resultats.push({ date_heure: d.toISOString(), ok: false, raison: 'erreur_serveur' });
    } else if (error && error.code === '23505') {
      // déjà pris (RDV confirmé existant, ou déjà bloqué) -> on ne casse rien, on signale juste
      resultats.push({ date_heure: d.toISOString(), ok: false, raison: 'deja_occupe' });
    } else {
      resultats.push({ date_heure: d.toISOString(), ok: true });
    }
  }

  return res.status(200).json({ resultats });
}
