// /api/pennylane-connecter.js
// 16/11/2026 — Onboarding honnête : avant, l'écran "Connecter" affichait
// "Connecté ✓" après un simple délai, quel que soit l'outil, sans jamais
// rien vérifier ni enregistrer réellement. Pour Pennylane, cet endpoint fait
// le vrai travail : il vérifie le jeton collé par l'artisan auprès de
// Pennylane lui-même, et ne le stocke QUE s'il est valide — par artisan,
// dans Supabase, dans une colonne séparée de `etat` (qui est renvoyée au
// navigateur par map_etat_lire : un jeton ne doit jamais y figurer).
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Entrée  : { cle, siret, token }  — cle = identifiant du compte artisan
//           (S.cle côté page, reçu après l'inscription), siret en repli si
//           cle est absente.
// Sortie  : { success:true } ou { success:false, error }

import { ipDepuisRequete, verifierLimite } from './_lib/rate-limit.js';
import * as pennylane from './_lib/pennylane.js';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers });
  if (!r.ok) throw new Error(`Supabase ${path} : ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  if (!SB || !KEY) {
    return res.status(500).json({ success: false, error: 'Configuration serveur incomplète.' });
  }

  const { cle, siret, token } = req.body || {};
  if ((!cle || typeof cle !== 'string') && (!siret || typeof siret !== 'string')) {
    return res.status(400).json({ success: false, error: 'Compte artisan non identifié.' });
  }
  if (!token || typeof token !== 'string' || token.length > 300) {
    return res.status(400).json({ success: false, error: 'Jeton manquant ou invalide.' });
  }

  const cleLimite = cle ? `pennylane-connecter:cle:${cle}` : `pennylane-connecter:ip:${ipDepuisRequete(req)}`;
  if (!(await verifierLimite(cleLimite, 10, 10 * 60))) {
    return res.status(429).json({ success: false, error: 'Trop de tentatives. Merci de patienter quelques minutes.' });
  }

  // 1. On vérifie VRAIMENT le jeton auprès de Pennylane avant toute chose —
  // jamais de "Connecté" sur un jeton qui n'a pas été testé.
  const verif = await pennylane.validerToken(token.trim());
  if (!verif.ok) {
    return res.status(400).json({ success: false, error: verif.erreur || "Ce jeton n'a pas pu être vérifié." });
  }

  // 2. On enregistre le jeton, par compte, dans une colonne séparée de
  // `etat` (jamais renvoyée au navigateur).
  try {
    const filtre = cle ? `cle=eq.${encodeURIComponent(cle)}` : `siret=eq.${encodeURIComponent(siret)}`;
    const lignes = await sb(`map_comptes?${filtre}&select=cle`);
    if (!Array.isArray(lignes) || lignes.length === 0) {
      return res.status(404).json({ success: false, error: 'Compte artisan introuvable.' });
    }
    await sb(`map_comptes?${filtre}`, {
      method: 'PATCH',
      body: JSON.stringify({ pennylane_token: token.trim(), maj: new Date().toISOString() }),
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur pennylane-connecter :', err);
    return res.status(500).json({ success: false, error: "Le jeton est valide, mais je n'ai pas pu l'enregistrer pour le moment. Réessayez." });
  }
}
