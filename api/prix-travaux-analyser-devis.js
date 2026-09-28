// /api/prix-travaux-analyser-devis.js
// 28/09/2026 — Le particulier qui a payé son estimation dépose le devis reçu
// d'un artisan (PDF ou photo). Claude lit le devis, en extrait les lignes et
// rapproche chacune des postes de NOTRE estimation détaillée (envoyés par la
// page). Le calcul des écarts (prix gonflés) est fait ensuite côté page, à
// partir des montants extraits : l'IA ne fait que lire et rapprocher, elle ne
// décide pas seule des chiffres.
//
// Réservé aux projets payés (session Stripe vérifiée), limité en nombre
// d'analyses pour maîtriser le coût.
//
// Entrée  : { session_id, fichier (base64), media_type, estimation: { lignes:[[libellé, montantHT]], ht, tva, metier, quantite }, inclus:[...] }
// Sortie  : { success, devis: { total_ttc, total_ht, taux_tva, surface, lignes:[...], inclus_trouves:[...], remarques:[...] } }

import { sb } from './_lib/prix-travaux-commande.js';
import { verifierLimite, ipDepuisRequete } from './_lib/rate-limit.js';

export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };

const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

function prompt(estimation, inclus) {
  const lignesRef = (estimation.lignes || []).map((l, i) => `${i}. ${l[0]} — ${Math.round(l[1])} € HT`).join('\n');
  return `Tu analyses le devis d'un artisan reçu par un particulier, pour le comparer à une estimation de référence.

Travaux : ${estimation.metier}. Quantité du projet : ${estimation.quantite}.
Estimation de référence (postes numérotés, montants HT, prix de marché 2026) :
${lignesRef}
Total HT de référence : ${Math.round(estimation.ht)} €. TVA attendue : ${String(estimation.tva * 100).replace('.', ',')} %.

Éléments qu'un devis sérieux doit mentionner (liste fermée) :
${inclus.map((x, i) => `- ${x}`).join('\n')}

Consignes :
1. Lis TOUTES les lignes chiffrées du devis (désignation, quantité, unité, prix unitaire HT, montant HT). Ne recopie pas les lignes de texte sans montant.
2. Pour chaque ligne, indique le ou les numéros de postes de référence qui correspondent (ref), ou une liste vide si aucun poste de référence ne correspond.
3. Classe chaque ligne dans "type" :
   - "ok" : ligne normale ;
   - "hors_projet" : prestation qui ne correspond à rien dans le projet décrit et ne semble pas nécessaire (option non demandée, doublon, prestation sans rapport) ;
   - "vague" : libellé imprécis qui empêche de savoir ce qui est facturé (« divers », « forfait », « fournitures » sans détail, « main d'œuvre » globale) ;
   - "doublon" : même prestation facturée deux fois.
   Pour tout type autre que "ok", explique en une phrase simple, pour un particulier, dans "raison".
4. Relève le total HT, le total TTC, le taux de TVA appliqué et, si elle apparaît, la surface ou la quantité principale.
5. Dans "inclus_trouves", recopie EXACTEMENT les éléments de la liste fermée qui figurent bien sur le devis.
6. Dans "remarques", jusqu'à 4 points d'attention concrets (acompte excessif > 30 %, absence d'assurance décennale, conditions de paiement, validité…). Pas de remarque sur les prix : ils sont comparés ailleurs.
7. Si le document n'est pas un devis de travaux ou est illisible, renvoie "lisible": false.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{"lisible":true,"artisan":"","total_ht":0,"total_ttc":0,"taux_tva":10,"surface":null,
"lignes":[{"designation":"","quantite":null,"unite":"","prix_unitaire_ht":null,"montant_ht":0,"ref":[0],"type":"ok","raison":""}],
"inclus_trouves":[],"remarques":[]}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  if (!(await verifierLimite('pt-analyse-ip:' + ipDepuisRequete(req), 20, 3600))) {
    return res.status(429).json({ success: false, error: 'Trop d\'analyses en peu de temps. Réessayez dans une heure.' });
  }
  const { session_id, fichier, media_type, estimation, inclus } = req.body || {};
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(String(session_id || ''))) {
    return res.status(403).json({ success: false, error: "L'analyse de devis est réservée aux estimations payées." });
  }
  if (!TYPES.includes(media_type) || typeof fichier !== 'string' || fichier.length < 100) {
    return res.status(400).json({ success: false, error: 'Déposez un PDF ou une photo (JPG, PNG) du devis.' });
  }
  if (fichier.length > 4_400_000) {
    return res.status(413).json({ success: false, error: 'Fichier trop lourd (4 Mo maximum). Prenez une photo ou exportez un PDF plus léger.' });
  }
  if (!estimation || !Array.isArray(estimation.lignes) || !(estimation.ht > 0)) {
    return res.status(400).json({ success: false, error: 'Calculez d\'abord votre estimation détaillée.' });
  }

  try {
    const [c] = await sb(`prix_travaux_commandes?stripe_session_id=eq.${session_id}&statut=in.(payee,erreur)&select=id`);
    if (!c) return res.status(403).json({ success: false, error: "L'analyse de devis est réservée aux estimations payées." });
    if (!(await verifierLimite('pt-analyse:' + session_id, 15, 86400))) {
      return res.status(429).json({ success: false, error: 'Vous avez atteint 15 analyses aujourd\'hui pour ce projet. Réessayez demain.' });
    }

    const propres = {
      metier: String(estimation.metier || '').slice(0, 60),
      quantite: Number(estimation.quantite) || '',
      ht: Number(estimation.ht),
      tva: Number(estimation.tva) || 0.1,
      lignes: estimation.lignes.slice(0, 40).map((l) => [String(l[0]).slice(0, 200), Number(l[1]) || 0]),
    };
    const inclusPropres = (Array.isArray(inclus) ? inclus : []).slice(0, 30).map((x) => String(x).slice(0, 120));

    const bloc = media_type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type, data: fichier } }
      : { type: 'image', source: { type: 'base64', media_type, data: fichier } };

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: [bloc, { type: 'text', text: prompt(propres, inclusPropres) }] }],
      }),
    });
    if (!r.ok) throw new Error('Claude ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const data = await r.json();
    const brut = (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').replace(/```json|```/g, '').trim();
    const debut = brut.indexOf('{'), fin = brut.lastIndexOf('}');
    const devis = JSON.parse(brut.slice(debut, fin + 1));

    if (!devis.lisible) {
      return res.status(200).json({ success: false, error: "Nous n'arrivons pas à lire ce document comme un devis. Essayez une photo plus nette, bien à plat et en pleine lumière, ou le PDF d'origine." });
    }
    // Garde-fous : on ne renvoie que des champs attendus, typés.
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const TYPES_LIGNE = ['ok', 'hors_projet', 'vague', 'doublon'];
    const propre = {
      artisan: String(devis.artisan || '').slice(0, 120),
      total_ht: num(devis.total_ht),
      total_ttc: num(devis.total_ttc),
      taux_tva: num(devis.taux_tva),
      surface: num(devis.surface),
      lignes: (Array.isArray(devis.lignes) ? devis.lignes : []).slice(0, 80).map((l) => ({
        designation: String(l.designation || '').slice(0, 250),
        quantite: num(l.quantite),
        unite: String(l.unite || '').slice(0, 15),
        prix_unitaire_ht: num(l.prix_unitaire_ht),
        montant_ht: num(l.montant_ht) || 0,
        ref: (Array.isArray(l.ref) ? l.ref : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < propres.lignes.length),
        type: TYPES_LIGNE.includes(l.type) ? l.type : 'ok',
        raison: String(l.raison || '').slice(0, 300),
      })),
      inclus_trouves: (Array.isArray(devis.inclus_trouves) ? devis.inclus_trouves : []).filter((x) => inclusPropres.includes(x)),
      remarques: (Array.isArray(devis.remarques) ? devis.remarques : []).slice(0, 4).map((x) => String(x).slice(0, 300)),
    };
    return res.status(200).json({ success: true, devis: propre });
  } catch (e) {
    console.error('prix-travaux-analyser-devis :', e.message);
    return res.status(500).json({ success: false, error: "L'analyse n'a pas abouti. Réessayez, ou recopiez les montants à la main ci-dessous." });
  }
}
