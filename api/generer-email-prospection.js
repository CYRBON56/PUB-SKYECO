// /api/generer-email-prospection.js
//
// Génère (ou réécrit) le sujet + contenu HTML de l'email de prospection
// "vendre l'abonnement Skyeco Pro à d'autres artisans du BTP"
// (prospects-paysagiste.html), via Claude, à partir d'un court brief libre
// de Cyrille — pour ne pas avoir à rédiger l'email à la main à chaque fois
// qu'il veut tester une nouvelle accroche.
//
// Requête attendue : POST
//   { motDePasseInterne, brief?, texteActuel? }
//   - brief (optionnel) : instruction libre ("plus court", "insiste sur le
//     prix", "ton plus direct"...) — si vide, génère une variante nouvelle
//     dans le même esprit que l'email par défaut de la page.
//   - texteActuel (optionnel) : contenu HTML actuellement dans le
//     formulaire, pour que le brief porte sur UNE réécriture de celui-ci
//     plutôt que sur une version totalement nouvelle à chaque fois.
//
// Variable d'environnement requise : ANTHROPIC_API_KEY (même clé que
// api/chat-skyeco.js, api/interpreter-chiffrage.js)

const MODELE_CLAUDE = 'claude-sonnet-4-6';

function construirePrompt(brief, texteActuel) {
  return `Tu écris, pour Cyrille Bon (dirigeant d'EcoSky by RMS, une entreprise du BTP en Bretagne), un email de prospection B2B destiné à d'AUTRES artisans du BTP (paysagistes, maçons, électriciens, plombiers...) pour leur vendre son propre outil marketing : Skyeco Pro (gestion Google Ads + Meta Ads, suivi des demandes clients, devis, le tout depuis un seul tableau de bord, pensé par un artisan pour des artisans).

Ton du message : direct, crédible, écrit par un artisan à un autre artisan (pas une agence marketing) — jamais survendu, pas de superlatifs creux ("révolutionnaire", "incontournable"...), des phrases courtes.

${texteActuel ? `Voici le contenu HTML ACTUEL de l'email, à prendre comme base pour la réécriture demandée ci-dessous plutôt que de repartir de zéro :\n"""\n${texteActuel}\n"""\n` : ''}
${brief ? `Instruction de Cyrille pour cette version : "${brief}"` : "Aucune instruction précise : propose une nouvelle variante, dans le même esprit que ci-dessus (ou, s'il n'y a pas de contenu actuel, une accroche crédible et directe)."}

Contraintes STRICTES sur le HTML produit :
- Doit contenir EXACTEMENT ces 4 jetons, tels quels, réutilisés par le système d'envoi : {{nom_entreprise}}, {{ville}}, {{metier}}, {{lien_cta}}.
- {{lien_cta}} doit être le href d'un lien ou bouton d'appel à l'action (ex: <a href="{{lien_cta}}" style="display:inline-block;background:#E8622C;color:#fff;padding:12px 22px;text-decoration:none;font-weight:700;">Découvrir Skyeco Pro</a>) — jamais utilisé ailleurs que dans ce href.
- HTML simple compatible email (pas de CSS externe, pas de classes, du <br> pour les retours à la ligne, des styles inline uniquement si besoin).
- Signature à la fin : "Cyrille Bon<br>EcoSky by RMS".
- Longueur raisonnable pour un email de prospection (pas un roman).

Réponds STRICTEMENT en JSON valide, sans aucun texte avant ou après, selon ce schéma exact :
{
  "subject": "sujet de l'email, court et concret, sans emoji, sans majuscules criardes",
  "html": "le contenu HTML complet de l'email tel que décrit ci-dessus"
}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { motDePasseInterne, brief, texteActuel } = req.body || {};

  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }

  try {
    const prompt = construirePrompt(
      (brief || '').toString().trim().slice(0, 800),
      (texteActuel || '').toString().trim().slice(0, 6000)
    );

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELE_CLAUDE,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail);
    }

    const data = await resp.json();
    const texteBrut = (data.content || [])
      .map((bloc) => (bloc.type === 'text' ? bloc.text : ''))
      .join('')
      .trim();

    let genere;
    try {
      const nettoye = texteBrut.replace(/```json|```/g, '').trim();
      genere = JSON.parse(nettoye);
    } catch (erreurParse) {
      console.error('Réponse Claude non parsable (generer-email-prospection) :', texteBrut);
      throw new Error("La génération n'a pas pu être interprétée.");
    }

    if (!genere || typeof genere.subject !== 'string' || typeof genere.html !== 'string' || !genere.html.includes('{{lien_cta}}')) {
      throw new Error('Réponse générée incomplète — réessayez.');
    }

    return res.status(200).json({ success: true, subject: genere.subject.trim(), html: genere.html.trim() });
  } catch (err) {
    console.error('Erreur generer-email-prospection :', err);
    return res.status(500).json({ success: false, error: "La génération n'est pas disponible pour le moment." });
  }
}
