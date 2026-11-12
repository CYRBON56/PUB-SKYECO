# Générateur de visuels Instagram — Contact Chantier

- `lib.py` : charte (bleu marine #163A63, jaune #FFC72C, bleu #2C5D8F, police Inter), logo, cartes, plan de maison, pins, animations.
- `posts.py` : posts/carrousels 1080x1350 (sortie dans /tmp/cc/out). Lit la photo `public/signature/cyrille-bon.jpg`.
- `reels.py` : reels 1080x1920, 30 fps (`python3 reels.py stills` pour des images de contrôle, `python3 reels.py r1|r2|r3` pour le rendu).
- Les scripts importent depuis /tmp/cc : copier ce dossier dans /tmp/cc avant de lancer.
- Médias publiés : `public/social/contact-chantier/` → https://www.skyeco.fr/social/contact-chantier/<fichier>
