// /api/cron-prospection-quotidienne.js
//
// Déclenché automatiquement toutes les 30 minutes par Vercel Cron (voir vercel.json),
// entre 6h et 19h UTC (~8h-21h heure française l'été, 7h-20h l'hiver). Appelle
// exactement le même endpoint que le bouton "Envoyer ce lot" de
// prospects-paysagiste.html — même logique d'envoi progressif, mêmes garde-fous
// (quota Resend, marquage obsolète, etc.), juste sans clic manuel.
//
// Envoi étalé en lots (300 toutes les 30 min, ~26 lots/jour pendant la plage
// horaire) plutôt qu'un seul gros lot le matin. Note : le lot était
// volontairement réduit à 30 depuis le 08-09/09/2026 pour limiter le risque
// d'être repéré comme spam par les filtres email (Gmail, Outlook, etc.) — ce
// choix de prudence a été explicitement mis de côté le 26/09/2026 à la
// demande de Cyrille, qui veut accélérer le volume envoyé aux
// paysagistes/espaces verts. À surveiller : taux de bounce/désabonnement et
// délivrabilité (Resend) dans les jours qui suivent ce changement.
//
// Variables d'environnement requises sur Vercel :
//   SKYECO_PROSPECTION_PASSWORD   -> même mot de passe que le portail "Accès réservé"
//   CRON_SECRET                    -> optionnel mais recommandé (Vercel l'envoie
//                                      automatiquement en header si défini, protège
//                                      cette URL contre un déclenchement externe)

const SITE_BASE = 'https://pub-skyeco-23ue.vercel.app';
const TAILLE_LOT = 300; // relevé de 30 à 300 le 26/09/2026 à la demande explicite de Cyrille, malgré le risque de réputation email évoqué ci-dessus (décision assumée)

// 28/09/2026 : le cron automatique envoie désormais la campagne "Estimateur BTP"
// (même sujet, même texte et même destination que le formulaire manuel de
// prospects-paysagiste.html) à la place de l'ancien email Skyeco IA Ads.
const SUJET_PAR_DEFAUT = "Chiffrez vos devis chantier en 30 secondes, depuis votre téléphone";
// Destination du bouton "Voir la démo" (enregistrée côté serveur par prospect, cf. api/lien.js)
const DESTINATION_CTA = "https://www.skyeco.fr/estimateur-btp-demo.html";
// Cible : mettre null pour envoyer à toutes les familles de métiers BTP.
const FAMILLE_METIER = 'Paysagisme & espaces verts';

const HTML_PAR_DEFAUT = `Bonjour {{nom_entreprise}},<br><br>Je m'appelle Cyrille, artisan comme vous — je gère RMS EcoSky, une entreprise de revêtements de sol. Sur chantier, j'ai toujours perdu du temps à chiffrer mes devis une fois rentré au bureau, alors j'ai créé mon propre outil : <strong>l'Estimateur BTP</strong>.<br><br>C'est une application qui calcule vos devis directement sur place, en 30 secondes :<br>— un catalogue de 260 postes BTP avec prix repères déjà intégré (terrassement, maçonnerie, VRD, assainissement, couverture, plomberie, électricité, menuiserie, isolation, peinture, carrelage, espaces verts),<br>— calcul automatique des surfaces, volumes et mètres linéaires,<br>— un devis prêt à envoyer, avec votre logo et vos coordonnées,<br>— aucune installation, ça fonctionne même sans réseau une fois ouvert une première fois.<br><br>Le plus simple, c'est de voir comment ça marche :<br><br><a href="{{lien_cta}}" style="display:inline-block;background:#ec4899;color:#fff;padding:12px 22px;text-decoration:none;font-weight:700;border-radius:6px;">▶ Voir la démo</a><br><br>2 jours d'essai gratuit, sans carte bancaire, puis 29,90€ HT en achat unique (sans abonnement) — ça peut être utile pour {{nom_entreprise}} à {{ville}} aussi, pour un métier comme {{metier}}.<br><br><img src="cid:signature-cyrille" width="64" height="64" alt="Cyrille Bon" style="border-radius:50%;display:block;margin-bottom:8px;">Cyrille Bon<br>Skyeco`;

export default async function handler(req, res) {
  // Protection : si CRON_SECRET est défini sur Vercel, Vercel l'envoie
  // automatiquement dans ce header pour ses propres appels programmés —
  // ça bloque tout déclenchement externe de cette URL par quelqu'un d'autre.
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ success: false, error: 'Non autorisé' });
    }
  }

  if (!process.env.SKYECO_PROSPECTION_PASSWORD) {
    console.error('SKYECO_PROSPECTION_PASSWORD manquante côté serveur');
    return res.status(500).json({ success: false, error: 'Configuration manquante' });
  }

  try {
    const resp = await fetch(`${SITE_BASE}/api/prospection-send-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        motDePasseInterne: process.env.SKYECO_PROSPECTION_PASSWORD,
        batchSize: TAILLE_LOT,
        familleMetier: FAMILLE_METIER || undefined, // 08/09/2026 : restreint à cette famille (taux de désabonnement ~4,8% hors cible sur le premier envoi test)
        videoUrl: DESTINATION_CTA,
        subject: SUJET_PAR_DEFAUT,
        html: HTML_PAR_DEFAUT,
      }),
    });
    const data = await resp.json();
    console.log('Cron prospection quotidienne —', JSON.stringify(data));
    return res.status(200).json(data);
  } catch (e) {
    console.error('Erreur cron-prospection-quotidienne :', e);
    return res.status(500).json({ success: false, error: e.message });
  }
}
