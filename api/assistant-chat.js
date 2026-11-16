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
// Depuis le 16/11/2026 : si PENNYLANE_API_TOKEN est configuré (voir
// ./_lib/pennylane.js), une demande de modification ou d'envoi qui cite un
// client va vraiment chercher son devis dans Pennylane (sans jamais deviner
// lequel s'il y a ambiguïté) et peut vraiment changer sa TVA. L'envoi réel
// par mail ne part QUE sur confirmation explicite du bouton affiché
// (requête avec direct_envoi_pennylane), jamais directement depuis une
// phrase interprétée par l'IA.
//
// Entrée  : { message, devis: [{id,client,ville,ttc,tva,statut}], produits: [{code,name,price,unit}], siret }
//        ou { direct_envoi_pennylane:true, pennylane_id, canal, siret }
// Sortie  : { success, action, devis_id, client, ville, lignes, tva, canal, reponse, source?, pennylane_id? }

import { ipDepuisRequete, verifierLimite } from './_lib/rate-limit.js';
import * as pennylane from './_lib/pennylane.js';

const ACTIONS = ['creer_devis', 'modifier_devis', 'envoyer_devis', 'relancer_devis', 'discussion'];

// Jeton Pennylane PAR ARTISAN, stocké côté serveur (voir
// /api/pennylane-connecter.js), jamais dans `etat` (renvoyée au navigateur).
// En repli, la variable d'environnement globale PENNYLANE_API_TOKEN (compte
// unique) pour compatibilité avec un déploiement mono-compte.
async function obtenirTokenPennylane(siret) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (siret && SB && KEY) {
    try {
      const r = await fetch(`${SB}/rest/v1/map_comptes?siret=eq.${encodeURIComponent(siret)}&select=pennylane_token`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      });
      if (r.ok) {
        const lignes = await r.json();
        const t = Array.isArray(lignes) && lignes[0] && lignes[0].pennylane_token;
        if (t) return t;
      }
    } catch (e) { /* on retombe sur le jeton global ci-dessous */ }
  }
  return process.env.PENNYLANE_API_TOKEN || null;
}

// Retrouve, sans ambiguïté, UN SEUL devis Pennylane correspondant au nom de
// client cité. Ne choisit jamais au hasard : si 0 client, plusieurs clients,
// 0 devis ou plusieurs devis correspondent, renvoie {ambigu:true, reponse}
// avec une question de clarification plutôt qu'un résultat.
async function trouverDevisPennylane(nomClient, token) {
  const clients = await pennylane.chercherClients(nomClient, token);
  if (clients.length === 0) {
    return { trouve: false, reponse: `Je ne trouve pas de client « ${nomClient} » dans Pennylane. Voulez-vous que je vérifie l'orthographe, ou que j'en crée un nouveau ?` };
  }
  if (clients.length > 1) {
    const noms = clients.slice(0, 6).map((c) => c.name).join(', ');
    return { trouve: false, reponse: `Plusieurs clients Pennylane correspondent à « ${nomClient} » : ${noms}. Lequel voulez-vous ?` };
  }
  const client = clients[0];
  const devisListe = await pennylane.listerDevisClient(client.id, token);
  if (devisListe.length === 0) {
    return { trouve: false, reponse: `${client.name} n'a aucun devis dans Pennylane pour l'instant. Voulez-vous que j'en crée un ?` };
  }
  if (devisListe.length > 1) {
    const noms = devisListe.slice(0, 6).map((d) => `${d.quote_number || ('#' + d.id)} (${d.status}, ${d.date || ''})`).join(', ');
    return { trouve: false, reponse: `${client.name} a plusieurs devis dans Pennylane : ${noms}. Lequel voulez-vous ?` };
  }
  const devisResume = devisListe[0];
  const devisComplet = await pennylane.obtenirDevis(devisResume.id, token);
  return { trouve: true, client, devis: devisComplet };
}

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

  // Envoi réel d'un devis Pennylane : déclenché uniquement par le clic du
  // bouton "✅ J'ai vérifié, j'envoie" après relecture du devis affiché — pas
  // par l'IA elle-même, pour qu'aucun envoi réel ne dépende d'une
  // interprétation de langage. Pas d'appel à Claude sur ce chemin.
  if (req.body && req.body.direct_envoi_pennylane) {
    const { pennylane_id, canal, siret: s } = req.body;
    if (!pennylane_id) return res.status(400).json({ success: false, error: 'Devis Pennylane manquant.' });
    const cleD = s ? `assistant-chat:siret:${s}` : `assistant-chat:ip:${ipDepuisRequete(req)}`;
    if (!(await verifierLimite(cleD, 40, 10 * 60))) {
      return res.status(429).json({ success: false, error: 'Trop d\'envois. Merci de patienter quelques minutes.' });
    }
    const jeton = await obtenirTokenPennylane(s);
    if (!pennylane.actif(jeton)) {
      return res.status(400).json({ success: false, error: 'Pennylane n\'est plus connecté.' });
    }
    try {
      await pennylane.envoyerDevisParMail(pennylane_id, undefined, jeton);
      const avis = canal === 'sms' ? " (le SMS n'est pas disponible pour l'instant : seul le mail a été envoyé)" : '';
      return res.status(200).json({ success: true, action: 'envoyer_devis', source: 'pennylane', reponse: `Devis envoyé par mail au client depuis Pennylane ✓${avis}` });
    } catch (err) {
      console.error('Erreur envoi Pennylane :', err);
      return res.status(500).json({ success: false, error: "L'envoi via Pennylane a échoué pour le moment." });
    }
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

    let action = ACTIONS.includes(r.action) ? r.action : 'discussion';
    const lignes = Array.isArray(r.lignes)
      ? r.lignes.filter((l) => Array.isArray(l) && l.length >= 4).map((l) => [String(l[0] || ''), String(l[1] || ''), Number(l[2]) || 0, Number(l[3]) || 0])
      : [];

    const sortie = {
      success: true,
      action,
      devis_id: r.devis_id || null,
      client: r.client || '',
      ville: r.ville || '',
      lignes,
      tva: typeof r.tva === 'number' ? r.tva : null,
      canal: r.canal === 'sms' ? 'sms' : (r.canal === 'mail' ? 'mail' : null),
      reponse: r.reponse || "D'accord.",
    };

    // Quand Pennylane est connecté et que la demande porte sur un devis qui
    // existe réellement là-bas (plutôt qu'un des devis créés dans la
    // conversation elle-même), on va vraiment le chercher et, pour
    // "modifier_devis", on applique vraiment le changement de TVA demandé.
    // On ne devine jamais lequel : voir trouverDevisPennylane. L'envoi réel
    // ne se déclenche QUE par le bouton de confirmation (direct_envoi_pennylane
    // ci-dessus) — jamais directement depuis cette décision de l'IA.
    const jetonPennylane = await obtenirTokenPennylane(siret);
    if (pennylane.actif(jetonPennylane) && sortie.client && (action === 'modifier_devis' || action === 'envoyer_devis') && !sortie.devis_id) {
      try {
        const trouve = await trouverDevisPennylane(sortie.client, jetonPennylane);
        if (!trouve.trouve) {
          sortie.action = 'discussion';
          sortie.reponse = trouve.reponse;
        } else if (action === 'modifier_devis') {
          const lignesActuelles = await pennylane.lignesDevis(trouve.devis, jetonPennylane);
          let devisAJour = trouve.devis;
          if (typeof sortie.tva === 'number') {
            devisAJour = await pennylane.changerTvaDevis(trouve.devis.id, lignesActuelles, sortie.tva, jetonPennylane);
          }
          const lignesAJour = await pennylane.lignesDevis(devisAJour, jetonPennylane);
          sortie.source = 'pennylane';
          sortie.pennylane_id = devisAJour.id;
          sortie.client = trouve.client.name;
          sortie.lignes = lignesAJour.map(pennylane.ligneAffichage);
          sortie.tva = typeof sortie.tva === 'number' ? sortie.tva : (pennylane.codeVersTaux(lignesAJour[0]?.vat_rate) ?? 20);
          sortie.reponse = (r.reponse || '') + ` (devis Pennylane ${devisAJour.quote_number || '#' + devisAJour.id} mis à jour — vérifiez avant de l'envoyer)`;
        } else if (action === 'envoyer_devis') {
          // L'IA a compris qu'il faut envoyer un devis Pennylane, mais
          // l'envoi réel attend toujours le bouton de confirmation : on
          // renvoie le devis à l'écran pour relecture au lieu d'envoyer.
          const lignesAJour = await pennylane.lignesDevis(trouve.devis, jetonPennylane);
          sortie.action = 'modifier_devis';
          sortie.source = 'pennylane';
          sortie.pennylane_id = trouve.devis.id;
          sortie.client = trouve.client.name;
          sortie.lignes = lignesAJour.map(pennylane.ligneAffichage);
          sortie.tva = pennylane.codeVersTaux(lignesAJour[0]?.vat_rate) ?? 20;
          sortie.canal = sortie.canal || 'mail';
          sortie.reponse = `Voici le devis Pennylane ${trouve.devis.quote_number || '#' + trouve.devis.id} de ${trouve.client.name}. Vérifiez-le, puis cliquez sur « J'ai vérifié, j'envoie » pour l'envoyer vraiment par mail.`;
        }
      } catch (err) {
        console.error('Erreur Pennylane (assistant-chat) :', err);
        sortie.action = 'discussion';
        sortie.reponse = "J'ai un souci pour accéder à Pennylane en ce moment — réessayez dans un instant, ou dites-le-moi si ça persiste.";
      }
    }

    return res.status(200).json(sortie);
  } catch (err) {
    console.error('Erreur assistant-chat :', err);
    return res.status(500).json({ success: false, error: "Je n'ai pas pu traiter votre demande pour le moment." });
  }
}
