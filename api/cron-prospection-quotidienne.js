// /api/cron-prospection-quotidienne.js
//
// Déclenché automatiquement une fois par jour par Vercel Cron (voir vercel.json),
// entre 8h et 10h heure française. Appelle exactement le même endpoint que le
// bouton "Envoyer ce lot" de prospects-paysagiste.html — même logique d'envoi
// progressif, mêmes garde-fous (quota Resend, marquage obsolète, etc.), juste
// sans clic manuel.
//
// Variables d'environnement requises sur Vercel :
//   SKYECO_PROSPECTION_PASSWORD   -> même mot de passe que le portail "Accès réservé"
//   CRON_SECRET                    -> optionnel mais recommandé (Vercel l'envoie
//                                      automatiquement en header si défini, protège
//                                      cette URL contre un déclenchement externe)

const SITE_BASE = 'https://pub-skyeco-23ue.vercel.app';
const TAILLE_LOT = 250; // dans la fourchette 200-300 demandée

const SUJET_PAR_DEFAUT = "2 minutes pour voir comment Skyeco Ads gère vos pubs à votre place";

const HTML_PAR_DEFAUT = `<img src="cid:logo-skyeco-ads" width="240" height="75" alt="Skyeco Ads" style="display:block;margin-bottom:18px;">Bonjour {{nom_entreprise}},<br><br>Je m'appelle Cyrille, artisan comme vous — je gère RMS EcoSky, une entreprise de revêtements de sol. J'ai été démarché par des agences pub qui prenaient mon budget sans jamais vraiment le piloter, alors j'ai créé mon propre outil : <strong>Skyeco Ads</strong>.<br><br>J'ai fait une vidéo de 2 minutes qui montre exactement comment ça marche pour un métier comme {{metier}} :<br>— vos Google Ads gérées et coachées automatiquement (mots-clés, suivi quotidien, correction des campagnes qui sous-performent),<br>— votre propre page vitrine avec carrousel photo et formulaire d'estimation de devis,<br>— vos prospects suivis par email et SMS, avec relances automatiques,<br>— vos devis envoyés avec signature électronique, par email et SMS.<br><br>Le plus simple, c'est de la regarder :<br><br><a href="{{lien_cta}}" style="display:inline-block;background:#E8622C;color:#fff;padding:12px 22px;text-decoration:none;font-weight:700;">▶ Voir la vidéo (2 min)</a><br><br>C'est gratuit à l'installation, avec un forfait de fonctionnement simple. Ça peut être utile pour {{nom_entreprise}} à {{ville}} aussi.<br><br><img src="cid:signature-cyrille" width="64" height="64" alt="Cyrille Bon" style="border-radius:50%;display:block;margin-bottom:8px;">Cyrille Bon<br>Skyeco Ads`;

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
        familleMetier: 'Paysagisme & espaces verts', // 08/09/2026 : restreint à cette famille — taux de désabonnement nettement plus élevé (~4,8%) hors de cette cible sur le premier envoi test
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
