// /api/assistant-chat.js
// 16/11/2026 — Dans l'onglet "Assistant" de Mon Assistant Pro, l'artisan parle
// librement à l'assistant (créer un devis, modifier ou renvoyer un devis déjà
// fait, relancer un client, ou poser n'importe quelle autre question). Avant,
// seule une reconnaissance par mots-clés (quantité + prix) fonctionnait ; tout
// le reste tombait sur un message figé. Ce endpoint fait vraiment comprendre
// la demande par Claude, qui dit quoi faire (créer / modifier / envoyer /
// relancer un devis, ou simplement répondre), à partir des devis déjà
// existants transmis par la page. L'action réelle (créer la fiche, changer la
// TVA, marquer comme envoyé...) reste exécutée côté page : ce endpoint ne fait
// que comprendre et décider, il ne modifie aucune donnée lui-même.
//
// Variable d'environnement requise : ANTHROPIC_API_KEY (déjà utilisée par
// api/chat-skyeco.js et api/assistant-document-qa.js sur ce projet).
//
// Entrée  : { message, devis: [{id,client,ville,ttc,tva,statut}], produits: [{code,name,price,unit}], siret }
// Sortie  : { success, action, devis_id, client, ville, lignes, tva, canal, reponse }

import { ipDepuisRequete, verifierLimite } from './_lib/rate-limit.js';

const ACTIONS = ['creer_devis', 'modifier_devis', 'envoyer_devis', 'relancer_devis', 'discussion'];

function systemPrompt(devis, produits) {
  const listeDevis = devis.length
    ? devis.map((d) => `- id="${d.id}" · client : ${d.client}${d.ville ? ' (' + d.ville + ')' : ''} · ${d.ttc != null ? Math.round(d.ttc) + ' € TTC' : ''} · TVA ${d.tva ?? 20} % · statut : ${d.statut}`).join('\n')
    : "(aucun devis créé pour l'instant)";
  const catalogue = produits.length
    ? produits.map((p) => `- ${p.code} : ${p.name} — ${p.price} € HT / ${p.unit}`).join('\n')
    : '(aucun produit au catalogue)';

  return `Tu es l'assistant IA d'un artisan dans l'application "Mon Assistant Pro". L'artisan te parle librement dans un chat pour gérer ses devis.

Devis déjà existants, créés précédemment dans cette conversation :
${listeDevis}

Catalogue de produits de l'artisan (code, désignation, prix HT, unité) :
${catalogue}

Réponds UNIQUEMENT avec un objet JSON strict, sans aucun texte autour, au format exact :
{"action":"creer_devis|modifier_devis|envoyer_devis|relancer_devis|discussion","devis_id":null,"client":"","ville":"","lignes":[["désignation","quantité et unité ou 'forfait'",0,0]],"tva":20,"canal":null,"reponse":""}

Règle 0 — NE JAMAIS DEVINER une information importante : si un élément nécessaire à l'action manque ou est ambigu (quel client exactement — en particulier si plusieurs devis de la liste pourraient correspondre au nom cité —, quel montant, quelle TVA, quel canal d'envoi, quelles lignes modifier, ou toute confirmation avant une action qui modifie ou envoie un devis), choisis action="discussion" et pose UNE question précise et courte dans "reponse" pour obtenir cette information, SANS exécuter d'action ni inventer de valeur. Ne passe à une action concrète (creer_devis, modifier_devis, envoyer_devis, relancer_devis) que lorsque tu as tout ce qu'il te faut pour l'exécuter sans supposer quoi que ce soit. C'est plus important que d'aller vite : mieux vaut une question de plus qu'une hypothèse fausse sur un document commercial réel.

Règles pour choisir l'action (après avoir vérifié qu'aucune clarification n'est nécessaire, cf. Règle 0) :
1. "creer_devis" : l'artisan dicte un NOUVEAU devis avec des quantités et des prix (ex: "40 m² de résine à 85 € le m²", ou en citant un code produit du catalogue). Remplis "lignes" avec chaque poste : [désignation, "quantité unité", prix unitaire HT (ou 0 si forfait), montant total HT de la ligne]. Pour un montant forfaitaire sans quantité, mets "forfait" comme 2e élément et 0 comme prix unitaire. Utilise le prix du catalogue si un produit correspond. Si le nom du client n'est pas cité clairement, ne mets pas "Nouveau client" par défaut : demande-le (Règle 0).
2. "modifier_devis" : l'artisan demande de refaire, changer ou corriger un devis qui existe DÉJÀ dans la liste ci-dessus (ex: changer la TVA, une ligne, un montant). Mets "devis_id" sur l'id exact du devis existant qui correspond SANS AMBIGUÏTÉ au client cité. Si plusieurs devis de la liste pourraient correspondre, ou si aucun ne correspond clairement, ne choisis pas au hasard : demande lequel (Règle 0). Ne remplis que ce qui doit changer : "tva" si elle doit changer (sinon null), "lignes" si des lignes doivent être remplacées (sinon tableau vide).
3. "envoyer_devis" : l'artisan demande d'envoyer ou de renvoyer un devis déjà créé. "devis_id" sur le devis concerné (même exigence de non-ambiguïté qu'au point 2). "canal" = "sms" si un SMS est demandé, "mail" si un mail est demandé ou si les deux sont cités ou rien n'est précisé.
4. "relancer_devis" : l'artisan demande de relancer un client qui n'a pas encore signé ou payé. "devis_id" si on peut identifier lequel sans ambiguïté, sinon demande (Règle 0).
5. "discussion" : toute autre demande — question sur le fonctionnement de l'application, conseil, remarque générale, besoin de clarification (Règle 0), ou demande de modifier/envoyer/relancer un devis qui ne correspond à AUCUN de ceux listés ci-dessus (dans ce cas, dis-le clairement dans "reponse", par exemple « Je ne trouve pas de devis pour ce client, voulez-vous que j'en crée un ? »).

"reponse" est TOUJOURS remplie : une ou deux phrases courtes, naturelles, en français, comme si tu parlais directement à l'artisan — y compris quand "reponse" est une question de clarification. Ne mentionne jamais le mot JSON ni la structure de données.`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { message, devis, produits, siret } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'Message manquant.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ success: false, error: 'Message trop long.' });
  }
  const listeDevis = Array.isArray(devis) ? devis.slice(0, 80) : [];
  const listeProduits = Array.isArray(produits) ? produits.slice(0, 200) : [];

  const cle = siret && typeof siret === 'string' && siret.trim()
    ? `assistant-chat:siret:${siret.trim()}`
    : `assistant-chat:ip:${ipDepuisRequete(req)}`;
  const autorise = await verifierLimite(cle, 40, 10 * 60);
  if (!autorise) {
    return res.status(429).json({ success: false, error: 'Trop de messages envoyés. Merci de patienter quelques minutes.' });
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: systemPrompt(listeDevis, listeProduits),
        messages: [{ role: 'user', content: message.trim() }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail);
    }

    const data = await resp.json();
    const texte = data.content?.[0]?.text || '';
    const debut = texte.indexOf('{');
    const fin = texte.lastIndexOf('}');
    if (debut === -1 || fin === -1) throw new Error('Réponse IA sans JSON : ' + texte.slice(0, 200));

    let r;
    try {
      r = JSON.parse(texte.slice(debut, fin + 1));
    } catch (e) {
      throw new Error('JSON invalide : ' + texte.slice(0, 200));
    }

    const action = ACTIONS.includes(r.action) ? r.action : 'discussion';
    const lignes = Array.isArray(r.lignes)
      ? r.lignes.filter((l) => Array.isArray(l) && l.length >= 4).map((l) => [String(l[0] || ''), String(l[1] || ''), Number(l[2]) || 0, Number(l[3]) || 0])
      : [];

    return res.status(200).json({
      success: true,
      action,
      devis_id: r.devis_id || null,
      client: r.client || '',
      ville: r.ville || '',
      lignes,
      tva: typeof r.tva === 'number' ? r.tva : null,
      canal: r.canal === 'sms' ? 'sms' : (r.canal === 'mail' ? 'mail' : null),
      reponse: r.reponse || "D'accord.",
    });
  } catch (err) {
    console.error('Erreur assistant-chat :', err);
    return res.status(500).json({ success: false, error: "Je n'ai pas pu traiter votre demande pour le moment." });
  }
}
