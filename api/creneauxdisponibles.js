// api/creneaux-disponibles.js
//
// GET /api/creneaux-disponibles?draft_id=<uuid>&jours=14
//
// Renvoie les créneaux d'1h disponibles pour un artisan (une ligne de
// skyeco_pro_vitrine_drafts), du lundi au samedi, de 9h à 20h (heure de
// Paris), sur les prochains `jours` jours (14 par défaut, 30 max). Dimanche
// fermé. Les créneaux déjà pris ou bloqués sont exclus. Endpoint public (pas
// d'authentification : n'importe quel client doit pouvoir consulter les
// disponibilités pour prendre RDV).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FUSEAU = 'Europe/Paris';
const HEURE_OUVERTURE = 9;   // 9h
const HEURE_FERMETURE = 20;  // dernier créneau se termine à 20h (donc commence à 19h)
const JOURS_FERMES = [0];    // 0 = dimanche (JS getDay), fermé. Lundi(1)..Samedi(6) ouverts.
const JOURS_MAX = 30;

// --- Petits utilitaires fuseau horaire (sans dépendance externe) ----------

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

// Construit l'instant UTC correspondant à l'heure "murale" y-m-d h:00 à Paris
function parisVersUTC(annee, mois0, jour, heure) {
  const guess = new Date(Date.UTC(annee, mois0, jour, heure, 0, 0));
  const decal = decalageMinutes(guess, FUSEAU);
  return new Date(guess.getTime() - decal * 60000);
}

// Date/heure "actuelle" décomposée en heure de Paris
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

  const draftId = req.query.draft_id;
  if (!draftId) {
    return res.status(400).json({ error: 'draft_id manquant' });
  }

  let jours = parseInt(req.query.jours, 10);
  if (!Number.isFinite(jours) || jours <= 0) jours = 14;
  jours = Math.min(jours, JOURS_MAX);

  const { annee, mois0, jour, instantUTC: maintenant } = maintenantAParis();

  // Génère la liste des créneaux théoriques (avant filtrage des pris/passés)
  const creneaux = []; // { iso, dateJour: 'YYYY-MM-DD', heure: number }
  for (let d = 0; d < jours; d++) {
    const dateBase = new Date(Date.UTC(annee, mois0, jour + d));
    const jourSemaine = dateBase.getUTCDay(); // approx suffisant pour filtrer dimanche
    if (JOURS_FERMES.includes(jourSemaine)) continue;

    for (let h = HEURE_OUVERTURE; h < HEURE_FERMETURE; h++) {
      const dateUTC = parisVersUTC(annee, mois0, jour + d, h);
      if (dateUTC.getTime() <= maintenant.getTime()) continue; // créneau déjà passé
      creneaux.push({
        iso: dateUTC.toISOString(),
        dateJour: dateUTC.toISOString().slice(0, 10),
        heure: h,
        timestampMs: dateUTC.getTime(),
      });
    }
  }

  if (creneaux.length === 0) {
    return res.status(200).json({ draft_id: draftId, jours: [] });
  }

  const bornInf = creneaux[0].iso;
  const bornSup = creneaux[creneaux.length - 1].iso;

  const { data: pris, error } = await supabase
    .from('rendez_vous_artisans')
    .select('date_heure')
    .eq('draft_id', draftId)
    .neq('statut', 'annule')
    .gte('date_heure', bornInf)
    .lte('date_heure', bornSup);

  if (error) {
    console.error('creneaux-disponibles: erreur Supabase', error);
    return res.status(500).json({ error: 'erreur_serveur' });
  }

  const prisSet = new Set((pris || []).map((r) => new Date(r.date_heure).getTime()));
  const disponibles = creneaux.filter((c) => !prisSet.has(c.timestampMs));

  // Regroupe par jour pour faciliter l'affichage front-end
  const parJour = {};
  for (const c of disponibles) {
    if (!parJour[c.dateJour]) parJour[c.dateJour] = [];
    parJour[c.dateJour].push({ heure: c.heure, iso: c.iso });
  }

  const joursTries = Object.keys(parJour).sort().map((date) => ({
    date,
    creneaux: parJour[date],
  }));

  return res.status(200).json({ draft_id: draftId, jours: joursTries });
}
