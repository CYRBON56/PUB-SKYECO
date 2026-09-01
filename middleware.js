// /middleware.js
// Bloque l'accès public à l'ENSEMBLE du site (toutes les pages HTML) tant
// que le site n'est pas finalisé — seul Cyrille peut y accéder, via un lien
// contenant une clé secrète.
//
// MISE EN PLACE (une fois) :
//   1. Sur Vercel → Project Settings → Environment Variables, ajouter
//      MAINTENANCE_BYPASS_KEY avec une valeur secrète de ton choix
//      (ex: une longue chaîne aléatoire).
//   2. Redéployer.
//   3. Ouvrir une fois : https://www.skyeco.fr/?cle=<la_valeur_choisie>
//      → un cookie est posé sur ce navigateur pour 30 jours, plus besoin
//      de retaper la clé ensuite sur ce même appareil/navigateur.
//
// DÉSACTIVER LA MAINTENANCE (site public à nouveau) :
//   Supprimer (ou vider) la variable MAINTENANCE_BYPASS_KEY sur Vercel et
//   redéployer — le site redevient accessible à tous, sans toucher au code.
//
// Les routes /api/* ne sont JAMAIS bloquées par ce garde-fou : sinon les
// tâches planifiées (crons) et les appels internes du site (paiement,
// enregistrement des formulaires, etc.) cesseraient de fonctionner même
// pour toi.

import { next } from '@vercel/edge';

export const config = {
  matcher: ['/((?!api/).*)'],
};

const NOM_COOKIE = 'skyeco_acces';

const PAGE_MAINTENANCE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site en construction</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f4ece2; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#14312a; text-align:center; padding:24px; }
  .box { max-width:420px; }
  .emoji { font-size:2.6rem; margin-bottom:10px; }
  h1 { font-size:1.3rem; margin:0 0 10px; }
  p { color:#5b6b64; line-height:1.5; margin:0; }
</style>
</head>
<body>
  <div class="box">
    <div class="emoji">🚧</div>
    <h1>Ce site est en cours de construction</h1>
    <p>Revenez bientôt.</p>
  </div>
</body>
</html>`;

export default function middleware(request) {
  const cle = process.env.MAINTENANCE_BYPASS_KEY;

  // Pas de clé configurée = maintenance désactivée, on laisse tout passer
  // sans rien vérifier (comportement normal du site).
  if (!cle) return next();

  const url = new URL(request.url);
  const cleFournie = url.searchParams.get('cle');
  const cookieValide = (request.headers.get('cookie') || '')
    .split(';')
    .some(c => c.trim() === `${NOM_COOKIE}=${cle}`);

  if (cleFournie === cle || cookieValide) {
    const reponse = next();
    if (cleFournie === cle && !cookieValide) {
      reponse.headers.append(
        'set-cookie',
        `${NOM_COOKIE}=${cle}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`
      );
    }
    return reponse;
  }

  return new Response(PAGE_MAINTENANCE, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
