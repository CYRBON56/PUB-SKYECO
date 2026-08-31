// api/mes-rdv.js
//
// POST /api/mes-rdv   body: { draftId, token, jours? }
//
// Renvoie, pour L'ARTISAN CONNECTÉ (identifié via son jeton de session — le
// même que mon-dashboard.html, vérifié ici avec la même logique que
// dashboard-verify-session.js), tous ses créneaux des `jours` prochains jours
// (30 par défaut) avec leur état :
//   'libre'         -> disponible, aucune ligne en base
//   'confirme'      -> RDV client (nom/téléphone/email inclus)
//   'indisponible'  -> bloqué manuellement par l'artisan
//
// En POST (et pas GET) volontairement : le jeton de session ne doit pas se
// retrouver dans une query string (logs serveur, historique navigateur),
// même logique que dashboard-verify-session.js.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// DASHBOARD_SESSION_SECRET

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FUSEAU = 'Europe/Paris';
const HEURE_OUVERTURE = 9;
const HEURE_FERMETURE = 20;
const JOURS_FERMES = [0];
const JOURS_MAX = 60;

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

function decalageMinutes(dateUTC, fuseau) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: fuseau, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(dateUTC).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  const heure = p.hour === '24' ? '00' : p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +heure, +p.minute, +p.second);
  return (asUTC - dateUTC.getTime()) / 60000;
}

function parisVersUTC(annee, mois0, jour, heure) {
  const guess = new Date(Date.UTC(annee, mois0, jour, heure, 0, 0));
  const decal = decalageMinutes(guess, FUSEAU);
  return new Date(guess.getTime() - decal * 60000);
}

function maintenantAParis() {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSEAU, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = dtf.formatToParts(now).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return { annee: +p.year, mois0: +p.month - 1, jour: +p.day };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'methode_non_autorisee' });
  }

  const { draftId, token } = req.body || {};
  if (!draftId || !token) {
    return res.status(401).json({ error: 'non_authentifie' });
  }
  const session = verifierToken(token, draftId);
  if (!session) {
    return res.status(401).json({ error: 'session_invalide' });
  }

  let jours = parseInt(req.body?.jours, 10);
  if (!Number.isFinite(jours) || jours <= 0) jours = 30;
  jours = Math.min(jours, JOURS_MAX);

  const { annee, mois0, jour } = maintenantAParis();

  const slots = [];
  for (let d = 0; d < jours; d++) {
    const dateBase = new Date(Date.UTC(annee, mois0, jour + d));
    if (JOURS_FERMES.includes(dateBase.getUTCDay())) continue;
    for (let h = HEURE_OUVERTURE; h < HEURE_FERMETURE; h++) {
      const dateUTC = parisVersUTC(annee, mois0, jour + d, h);
      slots.push({
        iso: dateUTC.toISOString(),
        dateJour: dateUTC.toISOString().slice(0, 10),
        heure: h,
        timestampMs: dateUTC.getTime(),
      });
    }
  }

  if (slots.length === 0) {
    return res.status(200).json({ jours: [] });
  }

  const { data: lignes, error } = await supabase
    .from('rendez_vous_artisans')
    .select('date_heure, statut, client_nom, client_telephone, client_email, client_message')
    .eq('draft_id', draftId)
    .neq('statut', 'annule')
    .gte('date_heure', slots[0].iso)
    .lte('date_heure', slots[slots.length - 1].iso);

  if (error) {
    console.error('mes-rdv: erreur Supabase', error);
    return res.status(500).json({ error: 'erreur_serveur' });
  }

  const parTimestamp = new Map((lignes || []).map((l) => [new Date(l.date_heure).getTime(), l]));

  const parJour = {};
  for (const s of slots) {
    const ligne = parTimestamp.get(s.timestampMs);
    if (!parJour[s.dateJour]) parJour[s.dateJour] = [];
    if (!ligne) {
      parJour[s.dateJour].push({ heure: s.heure, iso: s.iso, statut: 'libre' });
    } else if (ligne.statut === 'indisponible') {
      parJour[s.dateJour].push({ heure: s.heure, iso: s.iso, statut: 'indisponible' });
    } else {
      parJour[s.dateJour].push({
        heure: s.heure, iso: s.iso, statut: 'confirme',
        client_nom: ligne.client_nom, client_telephone: ligne.client_telephone,
        client_email: ligne.client_email, client_message: ligne.client_message,
      });
    }
  }

  const joursTries = Object.keys(parJour).sort().map((date) => ({ date, creneaux: parJour[date] }));
  return res.status(200).json({ jours: joursTries });
}
