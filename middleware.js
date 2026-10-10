// petitepart.com : la racine affiche l'appli Petite Part (public/petitepart/index.html).
// Sans middleware, public/index.html (l'accueil Skyeco) passerait avant les rewrites.
import { rewrite, next } from '@vercel/edge';

export const config = { matcher: ['/'] };

export default function middleware(req) {
  const host = (req.headers.get('host') || '').toLowerCase();
  if (host === 'petitepart.com') return rewrite(new URL('/petitepart/index.html', req.url));
  return next();
}
