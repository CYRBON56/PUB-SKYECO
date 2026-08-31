// api/mes-rdv.js
//
// GET /api/mes-rdv?jours=30
//
// Renvoie, pour L'ARTISAN CONNECTÉ (identifié via sa session, pas via un
// paramètre d'URL — voir requireArtisanSession ci-dessous), tous ses créneaux
// des `jours` prochains jours (30 par défaut) avec leur état :
//   'libre'         -> disponible, aucune ligne en base
//   'confirme'      -> RDV client (nom/téléphone/email inclus)
//   'indisponible'  -> bloqué manuellement par l'artisan
//
// Sert à alimenter public/mes-rdv.html (vue calendrier + blocage de créneaux
// côté dashboard artisan).
//
// ⚠️ INTÉGRATION REQUISE : requireArtisanSession() ci-dessous est un
// placeholder. Branche-le sur la MÊME vérification de session signée que
// mon-dashboard.html utilise déjà (cookie signé avec DASHBOARD_SESSION_SECRET)
// et fais-le retourner l'artisan_id de la session. Je n'ai pas le code exact
// de mon-dashboard.html dans cette session pour le dupliquer correctement —
// mieux vaut ce garde-fou explicite qu'une auth devinée et potentiellement
// fausse (un artisan ne doit jamais pouvoir voir/bloquer le calendrier d'un
// autre).

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

function requireArtisanSession(req) {
  // TODO : remplace ce bloc par la vraie vérification (cookie signé,
  // DASHBOARD_SESSION_SECRET) déjà utilisée par mon-dashboard.html, et
  // retourne l'artisan_id qu'elle contient.
  throw Object.assign(new Error('requireArtisanSession non implémenté'), { statusCode: 501 });
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
  return { annee: +p.year, mois0: +p.month - 1, jour: +p.day, instantUTC: now };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'methode_non_autorisee' });
  }

  let artisanId;
  try {
    artisanId = requireArtisanSession(req);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ error: 'non_authentifie', message: e.message });
  }

  let jours = parseInt(req.query.jours, 10);
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
    .eq('artisan_id', artisanId)
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
