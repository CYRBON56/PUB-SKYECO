// api/bloquer-creneau.js
//
// POST /api/bloquer-creneau   body: { date_heure }
// POST /api/bloquer-creneau   body: { date_heure_debut, date_heure_fin }  (bloc de plusieurs créneaux, ex: une journée)
//
// Marque un ou plusieurs créneaux comme 'indisponible' pour L'ARTISAN CONNECTÉ
// (vacances, jour off...). N'affecte jamais un créneau déjà 'confirme' (un
// vrai RDV client) : la tentative échoue simplement (créneau déjà occupé).
//
// ⚠️ Même remarque que mes-rdv.js : requireArtisanSession() est un
// placeholder à brancher sur la session existante de mon-dashboard.html.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function requireArtisanSession(req) {
  // TODO : voir api/mes-rdv.js — même intégration à faire ici.
  throw Object.assign(new Error('requireArtisanSession non implémenté'), { statusCode: 501 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'methode_non_autorisee' });
  }

  let artisanId;
  try {
    artisanId = requireArtisanSession(req);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ error: 'non_authentifie', message: e.message });
  }

  const { date_heure, date_heure_debut, date_heure_fin } = req.body || {};

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
      .insert({ artisan_id: artisanId, date_heure: d.toISOString(), statut: 'indisponible' });

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
