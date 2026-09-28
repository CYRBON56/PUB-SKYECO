// /api/prix-travaux-sauver.js
// Enregistre les modifications de réponses d'un projet payé (options, matériaux…).
// Le type de travaux et le département restent verrouillés ; la quantité ne peut
// varier que de 20 % au plus (règle « un achat, un projet » des CGV).

import { sb } from './_lib/prix-travaux-commande.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const { session_id, reponses } = req.body || {};
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(String(session_id || ''))) return res.status(400).json({ error: 'Lien invalide' });
  if (!reponses || typeof reponses !== 'object' || JSON.stringify(reponses).length > 5000) return res.status(400).json({ error: 'Réponses invalides' });
  try {
    const [c] = await sb(`prix_travaux_commandes?stripe_session_id=eq.${session_id}&statut=in.(payee,erreur)&select=id,departement,quantite,reponses`);
    if (!c) return res.status(404).json({ error: 'Projet introuvable' });
    const qty = Number(reponses.qty);
    if (!(qty > 0) || Math.abs(qty - c.quantite) / c.quantite > 0.2) return res.status(400).json({ error: 'La quantité ne peut varier que de 20 % par rapport à votre achat.' });
    const nouvelles = { ...reponses, dept: c.departement, projet: reponses.projet || c.reponses.projet };
    await sb(`prix_travaux_commandes?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ reponses: nouvelles }) });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('prix-travaux-sauver :', e.message);
    return res.status(500).json({ error: 'Enregistrement impossible pour le moment.' });
  }
}
