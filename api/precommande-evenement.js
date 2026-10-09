// /api/precommande-evenement.js
// 09/10/2026 — Compteur anonyme (visite, clic sur Précommander) des 3 pages
// de test des applis d'hiver. Aucune donnée personnelle, aucun cookie.
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';
import { sb, PRODUITS } from './_lib/precommande.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  if (!Object.hasOwn(PRODUITS, b?.produit || '') || !['visite', 'clic_precommande'].includes(b?.type)) return res.status(400).end();
  if (!(await verifierLimite('preco-evt:' + ipDepuisRequete(req), 30, 600))) return res.status(204).end();
  const source = typeof b.source === 'string' ? b.source.slice(0, 40).replace(/[^a-z0-9_-]/gi, '') || null : null;
  try { await sb('precommande_evenements', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ produit: b.produit, type: b.type, source }) }); } catch {}
  return res.status(204).end();
}
