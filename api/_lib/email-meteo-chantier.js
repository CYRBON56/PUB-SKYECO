// api/_lib/email-meteo-chantier.js
// 09/10/2026 — Email de test de la demande "Météo Chantier" (précommande).
// Même format que les campagnes de prospection-send-batch : variables
// {{nom_entreprise}}, {{ville}}, {{metier}} et {{lien_cta}} (lien suivi).
// NE PART PAS tout seul : à brancher sur le cron ou le formulaire
// prospects-paysagiste.html uniquement après accord de Cyrille.

export const SUJET_METEO_CHANTIER = 'Demain, vous pouvez couler ou pas ? Le feu vert météo, chantier par chantier';

export const DESTINATION_METEO_CHANTIER = 'https://www.skyeco.fr/meteo-chantier.html?src=email#essayer';

export const FAMILLES_METEO_CHANTIER = [
  'Isolation / enveloppe (RGE)',
  'Rénovation (RGE)',
];

export const HTML_METEO_CHANTIER = `<img src="https://www.skyeco.fr/images/skyeco-logo-email.png" width="160" height="52" alt="Skyeco" style="display:block;margin-bottom:18px;">Bonjour {{nom_entreprise}},<br><br>
Je m'appelle Cyrille, je dirige Skyeco et je suis aussi artisan dans le Morbihan (sols résine, VRD). Chaque hiver, c'est la même chose : on charge le camion, on arrive sur le chantier, et il fait trop humide, ou il a gelé, ou il va pleuvoir avant que ça sèche. Journée perdue, ou pire, travail à refaire.<br><br>
Alors on prépare <strong>Météo Chantier</strong> : une appli qui vous dit chaque matin, pour chacun de vos chantiers, si vous pouvez y aller et à quelle heure.<br>
— elle croise gel, point de rosée, humidité et pluie au point exact du chantier,<br>
— avec les règles de votre métier (enduit, ITE, étanchéité, béton, peinture…),<br>
— et vous envoie l'alerte la veille au soir : « Demain, Vannes : non, gel au sol ».<br><br>
<a href="{{lien_cta}}" style="display:inline-block;background:#e3a008;color:#1b1403;padding:12px 22px;text-decoration:none;font-weight:700;border-radius:6px;">Essayer sur ma commune</a><br><br>
19,90 € une seule fois, sans abonnement. Elle sort fin novembre : si vous la précommandez et qu'elle n'est pas prête le 30 novembre, vous êtes remboursé automatiquement.<br><br>
Et si vous pensez que ça ne vous servirait pas, une ligne en réponse m'aide aussi : je veux construire ce qui sert vraiment aux artisans.<br><br>
<img src="cid:signature-cyrille" width="64" height="64" alt="Cyrille Bon" style="border-radius:50%;display:block;margin-bottom:8px;">Cyrille Bon<br>Skyeco`;
