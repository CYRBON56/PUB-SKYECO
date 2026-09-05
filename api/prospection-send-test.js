// /api/prospection-send-test.js
//
// Envoie UN SEUL email de test (vers l'adresse de son choix, typiquement la
// sienne) avec le sujet/contenu actuellement en cours de rédaction dans
// prospects-paysagiste.html — pour vérifier le rendu avant d'envoyer un
// vrai lot à des prospects. Ne touche JAMAIS à la table prospects_paysagiste
// (pas de token de tracking, pas de compteur, pas de statut modifié) :
// complètement neutre, peut être renvoyé autant de fois que nécessaire.
//
// Requête attendue : POST
//   { motDePasseInterne, destinataire, subject, html, videoUrl? }
//   Mêmes placeholders que l'envoi réel ({{nom_entreprise}}, {{ville}},
//   {{metier}}, {{lien_cta}}), remplacés ici par des valeurs d'exemple.
//
// Variables d'environnement requises : RESEND_API_KEY, INTERNAL_ACCESS_PASSWORD

const RESEND_FROM = 'Skyeco Pro <notifications@ecoskybyrms.fr>';
const DESTINATION_PROSPECTION_ARTISANS = 'https://www.skyeco.fr/skyeco-pro-formulaire-creation.html';

const EXEMPLE = {
  nom_entreprise: 'Entreprise Exemple SARL',
  ville: 'Votre Ville',
  metier: 'Votre métier',
};

// Photo de signature embarquée en pièce jointe CID (pas une URL distante
// vue par le client mail) : Resend télécharge lui-même l'image depuis
// cette URL au moment de l'envoi et l'intègre dans l'email — le webmail du
// destinataire ne fait plus aucune requête réseau pour l'afficher, donc les
// blocages/soucis de cache des proxys d'images des FAI n'ont plus d'effet.
const PHOTO_SIGNATURE_CONTENT_ID = 'signature-cyrille';
const PHOTO_SIGNATURE_URL = 'https://www.skyeco.fr/images/cyrille-bon-prospection.jpg';

function echapperHtml(v) {
  return String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function emailValide(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { motDePasseInterne, destinataire, subject, html, videoUrl } = req.body || {};

  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }
  if (!emailValide(destinataire)) {
    return res.status(400).json({ success: false, error: 'Adresse email de test invalide.' });
  }
  if (!subject || !html || !html.includes('{{lien_cta}}')) {
    return res.status(400).json({ success: false, error: 'Sujet manquant, ou contenu sans {{lien_cta}} pour le bouton d\'appel à l\'action.' });
  }

  const lienCta = videoUrl || DESTINATION_PROSPECTION_ARTISANS;

  const htmlTest = html
    .replaceAll('{{nom_entreprise}}', echapperHtml(EXEMPLE.nom_entreprise))
    .replaceAll('{{ville}}', echapperHtml(EXEMPLE.ville))
    .replaceAll('{{metier}}', echapperHtml(EXEMPLE.metier))
    .replaceAll('{{lien_cta}}', lienCta)
    + `<p style="font-size:11px;color:#999;margin-top:24px;">— Ceci est un envoi de TEST (email de démonstration, valeurs d'exemple ci-dessus) —</p>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [destinataire.trim()],
        subject: `[TEST] ${subject}`,
        html: htmlTest,
        attachments: [
          { path: PHOTO_SIGNATURE_URL, filename: 'cyrille-bon-prospection.jpg', content_id: PHOTO_SIGNATURE_CONTENT_ID },
        ],
      }),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.message || `Resend a répondu ${resp.status}`);
    }

    return res.status(200).json({ success: true, envoyeA: destinataire.trim() });
  } catch (err) {
    console.error('prospection-send-test error:', err);
    return res.status(500).json({ success: false, error: err.message || "Envoi du test impossible pour le moment." });
  }
}
