// /api/cron-campagne-chantiers.js : lot quotidien (jours ouvrés, 9 h) de l'emailing artisans,
// seulement si la campagne est activée depuis skyeco.fr/artisans-chantiers.html. Rapport à Cyrille.
import { sb } from './_lib/prix-travaux-commande.js';
import { envoyerLot, statistiques } from './_lib/campagne-chantiers.js';
export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const [r] = await sb('campagne_chantiers_reglages?id=eq.1&select=*');
    if (!r?.active) return res.status(200).json({ ok: true, inactive: true });
    const lot = await envoyerLot({ taille: r.taille_lot });
    const s = await statistiques();
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0) + ' %';
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Skyeco Chantiers <chantiers@ecoskybyrms.fr>', to: [process.env.AGENT_RAPPORT_EMAIL || 'c.bon@ecosky.fr'], subject: `Emailing artisans : ${lot.envoyes} envoyés aujourd'hui, ${s.inscrits} inscrits au total`,
        html: `<p>Lot du jour : <strong>${lot.envoyes}</strong> emails envoyés${lot.termine ? ' (plus personne à contacter)' : ''}.</p><p>Depuis le début : ${s.envoyes} envoyés, ${s.ouverts} ouverts (${pct(s.ouverts, s.envoyes)}), ${s.cliques} clics (${pct(s.cliques, s.envoyes)}), ${s.desabonnes} désinscriptions, <strong>${s.inscrits} artisans inscrits</strong>.</p><p>Détail et réglages : <a href="https://www.skyeco.fr/artisans-chantiers.html">skyeco.fr/artisans-chantiers.html</a></p>` }) }).catch(() => {});
    return res.status(200).json({ ok: true, ...lot });
  } catch (e) { console.error('cron-campagne-chantiers :', e.message); return res.status(500).json({ ok: false, error: e.message }); }
}
