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

const SUJET_PAR_DEFAUT = "Testez gratuitement pendant 1 mois, sans inscription";

const HTML_PAR_DEFAUT = `<img src="cid:logo-skyeco-ads" width="240" height="75" alt="Skyeco IA Ads" style="display:block;margin-bottom:18px;">Bonjour {{nom_entreprise}},<br><br>Je m'appelle Cyrille, artisan comme vous — je gère RMS EcoSky, une entreprise de revêtements de sol. Après avoir été démarché par des agences pub qui prenaient mon budget sans jamais vraiment le piloter, j'ai développé ma propre IA : elle gère mes campagnes Google Ads, alimente mon formulaire vitrine pour capter les demandes, et anime un tableau de bord qui relance mes prospects avec emails et SMS automatiques.<br><br>C'est totalement <strong>gratuit le premier mois</strong>, et vous pouvez découvrir l'outil <strong>sans aucune inscription</strong> : ouvrez simplement le tableau de bord de démonstration et explorez-le à votre rythme, pour un métier comme {{metier}} :<br>— vos campagnes Google Ads gérées et coachées par l'IA (mots-clés, suivi quotidien, correction des campagnes qui sous-performent),<br>— votre propre formulaire vitrine pour capter et qualifier vos demandes de devis,<br>— un tableau de bord qui relance vos prospects avec emails et SMS automatiques,<br>— vos devis envoyés avec signature électronique, par email et SMS.<br><br>Le jour où vous voulez passer en ligne pour de vrai, on récupère simplement vos informations d'entreprise (logo, photos, coordonnées, description) pour que votre vitrine et vos annonces aient une image professionnelle face à vos prospects — jusque-là, rien n'est engageant ni visible publiquement.<br><br><a href="{{lien_cta}}" style="display:inline-block;background:#E8622C;color:#fff;padding:12px 22px;text-decoration:none;font-weight:700;">▶ Essayer gratuitement, sans inscription</a><br><br>Ça peut être utile pour {{nom_entreprise}} à {{ville}} aussi.<br><br><img src="cid:signature-cyrille" width="64" height="64" alt="Cyrille Bon" style="border-radius:50%;display:block;margin-bottom:8px;">Cyrille Bon<br>Skyeco IA Ads`;

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
