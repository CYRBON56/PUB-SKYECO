// api/debloquer-creneau.js
//
// POST /api/debloquer-creneau   body: { date_heure }
//
// Libère un créneau précédemment bloqué par l'artisan (statut 'indisponible'
// uniquement). Ne touche JAMAIS une ligne 'confirme' : impossible d'annuler
// un vrai RDV client depuis cet endpoint, par sécurité.
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

  const { date_heure } = req.body || {};
  const d = new Date(date_heure);
  if (!date_heure || Number.isNaN(d.getTime())) {
    return res.status(400).json({ error: 'date_invalide' });
  }

  // On ne supprime que si la ligne appartient bien à cet artisan ET est un
  // blocage manuel (jamais un RDV confirmé).
  const { data, error } = await supabase
    .from('rendez_vous_artisans')
    .delete()
    .eq('artisan_id', artisanId)
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
