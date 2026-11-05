# Vidéos TikTok Maison au Chaud

Générateur des vidéos de la série « 30 jours pour une maison plus chaude » (@maisonauchaud3).

    python3 render.py scripts_sN.json sortie/ ../../public/videos/skyeco-musique.m4a

- `scripts_sN.json` : une semaine de scripts (id, jour, hook[2], steps[3], caption).
- Les MP4 vont dans `public/videos/mac/` puis sont servis sur https://www.skyeco.fr/videos/mac/<id>.mp4
- Publication : Metricool, marque « maison au chaud » (blogId 7274900), 1 vidéo/jour à 17h.
