// petitepart.com : la racine affiche l'appli Petite Part (public/petitepart/index.html).
// Sans middleware, public/index.html (l'accueil Skyeco) passerait avant les rewrites.
import { rewrite, next } from '@vercel/edge';

export const config = { matcher: ['/', '/contact-chantier', '/contact-chantier/demo', '/mon-assistant-pro'] };

export default function middleware(req) {
  const host = (req.headers.get('host') || '').toLowerCase();
  const path = new URL(req.url).pathname;
  // Applis Skyeco : sans la barre finale, les liens relatifs de l'appli ne marchent pas.
  if (path === '/contact-chantier' || path === '/mon-assistant-pro') {
    const u = new URL(req.url); u.pathname = path + '/'; return Response.redirect(u, 308);
  }
  if (path === '/contact-chantier/demo') {
    const u = new URL(req.url); u.pathname = '/contact-chantier/demo.html'; return Response.redirect(u, 308);
  }
  if (host === 'petitepart.com') return rewrite(new URL('/petitepart/index.html', req.url));
  // easyrock.skyeco.fr : la racine affiche la documentation easyRock (public/easyrock/index.html).
  if (host === 'easyrock.skyeco.fr') return rewrite(new URL('/easyrock/index.html', req.url));
  return next();
}
