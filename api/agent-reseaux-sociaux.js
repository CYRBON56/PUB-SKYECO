// /api/agent-reseaux-sociaux.js
// Agent IA "réseaux sociaux" (27/09/2026) — tourne en tâche planifiée
// (cron, voir vercel.json), et pour chaque artisan Skyeco Pro qui a au
// moins un réseau connecté ET la publication automatique active
// (skyeco_pro_social_connections.auto_publication_active) :
//   1. Choisit une photo de chantier/réalisation pas encore utilisée
//      (skyeco_pro_vitrine_drafts.photos / photos_avant_apres).
//   2. Fait rédiger une légende + hashtags par Claude, adaptés au métier et
//      à l'entreprise de l'artisan.
//   3. Publie directement sur chaque réseau connecté (Facebook, Instagram,
//      Google Business Profile, TikTok, Pinterest) — décision de Cyrille
//      du 27/09/2026 : l'agent publie seul, sans validation préalable.
//   4. Journalise le résultat (succès/erreur par réseau) dans
//      skyeco_pro_social_posts, visible dans le dashboard artisan.
//
// Garde-fous :
//   - Au plus 1 nouveau post par artisan tous les 3 jours (~2 posts/semaine)
//     — évite de spammer les réseaux d'un artisan très actif niveau photos.
//   - Un artisan sans AUCUN réseau connecté ne coûte rien : ni photo
//     choisie, ni appel Claude — on ne traite que les connexions existantes.
//   - Traite au plus MAX_ARTISANS_PAR_EXECUTION artisans par exécution pour
//     lisser la charge (le cron repasse de toute façon le lendemain).
//   - Si TOUTES les photos ont déjà été utilisées, on recommence au début
//     de la liste plutôt que de ne plus jamais publier.
//
// Variables d'environnement requises :
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { estConnecte, reseauxConnectes, publierFacebook, publierInstagram, publierGoogleBusiness, publierTikTok, publierPinterest } from './_lib/social-publish.js';

const MODELE_CLAUDE = 'claude-sonnet-4-6';
const DELAI_MIN_ENTRE_POSTS_JOURS = 3;
const MAX_ARTISANS_PAR_EXECUTION = 20;

const supaHeaders = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

async function genererLegende({ entreprise, metier, ville }) {
  const systemPrompt = `Tu rédiges des légendes de publication pour les réseaux sociaux (Facebook, Instagram, Google Business Profile, TikTok, Pinterest) d'artisans du BTP/paysagisme en France. Une seule légende, utilisable telle quelle sur tous ces réseaux : chaleureuse, courte (3-4 phrases maximum), qui met en valeur une réalisation récente sans inventer de détails techniques précis (tu ne connais pas le détail exact du chantier sur cette photo). Termine par 3 à 5 hashtags pertinents pour le métier et la localisation, sur une ligne à part. Réponds UNIQUEMENT avec un objet JSON : {"legende": "...", "hashtags": ["...", "..."]} — sans les hashtags dans le champ legende.`;
  const messageUtilisateur = `Entreprise : ${entreprise || 'un artisan'}\nMétier : ${Array.isArray(metier) ? metier.join(', ') : (metier || 'BTP/paysagisme')}\nZone d'intervention : ${ville || 'non précisée'}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELE_CLAUDE,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: messageUtilisateur }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude (légende) : ${await resp.text()}`);
  const data = await resp.json();
  const texte = data?.content?.[0]?.text || '{}';
  const jsonMatch = texte.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : texte);
  return { legende: parsed.legende || '', hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [] };
}

function choisirPhoto(draft, photosDejaUtilisees) {
  const toutesLesPhotos = [
    ...(Array.isArray(draft.photos) ? draft.photos : []),
    ...(Array.isArray(draft.photos_avant_apres) ? draft.photos_avant_apres.map(p => (typeof p === 'string' ? p : p?.apres || p?.avant)).filter(Boolean) : []),
  ];
  if (!toutesLesPhotos.length) return null;
  const nonUtilisees = toutesLesPhotos.filter(url => !photosDejaUtilisees.has(url));
  // Si tout a déjà servi, on recommence au début plutôt que de bloquer.
  return nonUtilisees.length ? nonUtilisees[0] : toutesLesPhotos[0];
}

export default async function handler(req, res) {
  // Cron Vercel uniquement (pas d'appel public) — voir vercel.json.
  if (req.headers['user-agent'] !== 'vercel-cron/1.0' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const resultats = { traites: 0, publies: 0, ignores_sans_reseau: 0, ignores_trop_recent: 0, erreurs: [] };

  try {
    const connexionsResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_connections?auto_publication_active=eq.true&select=*`,
      { headers: supaHeaders }
    );
    if (!connexionsResp.ok) throw new Error('Lecture des connexions impossible : ' + (await connexionsResp.text()));
    const connexions = await connexionsResp.json();

    for (const connexion of connexions.slice(0, MAX_ARTISANS_PAR_EXECUTION)) {
      const draftId = connexion.draft_id;
      const reseaux = reseauxConnectes(connexion);
      if (!reseaux.length) {
        resultats.ignores_sans_reseau++;
        continue;
      }

      // Garde-fou fréquence : pas plus d'un post tous les
      // DELAI_MIN_ENTRE_POSTS_JOURS jours par artisan.
      const dernierPostResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_posts?draft_id=eq.${draftId}&genere_par_ia=eq.true&select=created_at,photo_url&order=created_at.desc&limit=50`,
        { headers: supaHeaders }
      );
      const postsRecents = dernierPostResp.ok ? await dernierPostResp.json() : [];
      const dernierPost = postsRecents[0];
      if (dernierPost) {
        const joursDepuis = (Date.now() - new Date(dernierPost.created_at).getTime()) / (1000 * 60 * 60 * 24);
        if (joursDepuis < DELAI_MIN_ENTRE_POSTS_JOURS) {
          resultats.ignores_trop_recent++;
          continue;
        }
      }

      const draftResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,metier,adresse_ville,photos,photos_avant_apres`,
        { headers: supaHeaders }
      );
      const draftRows = draftResp.ok ? await draftResp.json() : [];
      const draft = draftRows[0];
      if (!draft) continue;

      const photosDejaUtilisees = new Set(postsRecents.map(p => p.photo_url).filter(Boolean));
      const photoUrl = choisirPhoto(draft, photosDejaUtilisees);
      if (!photoUrl) {
        resultats.ignores_sans_reseau++; // pas de photo -> rien à publier, même chose côté suivi
        continue;
      }

      try {
        const { legende, hashtags } = await genererLegende({ entreprise: draft.entreprise, metier: draft.metier, ville: draft.adresse_ville });
        const legendeComplete = hashtags.length ? `${legende}\n\n${hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')}` : legende;

        const resultatsParReseau = {};
        for (const reseau of reseaux) {
          try {
            if (reseau === 'facebook') resultatsParReseau.fb_post_id = await publierFacebook(connexion, { legende: legendeComplete, photoUrl });
            else if (reseau === 'instagram') resultatsParReseau.ig_media_id = await publierInstagram(connexion, { legende: legendeComplete, photoUrl });
            else if (reseau === 'google_business') resultatsParReseau.gbp_post_id = await publierGoogleBusiness(draftId, connexion, { legende: legendeComplete, photoUrl });
            else if (reseau === 'tiktok') resultatsParReseau.tiktok_post_id = await publierTikTok(draftId, connexion, { legende: legendeComplete, photoUrl });
            else if (reseau === 'pinterest') resultatsParReseau.pinterest_pin_id = await publierPinterest(connexion, { legende: legendeComplete, photoUrl });
          } catch (erreurReseau) {
            const cleErreur = { facebook: 'fb_erreur', instagram: 'erreur', google_business: 'gbp_erreur', tiktok: 'tiktok_erreur', pinterest: 'pinterest_erreur' }[reseau];
            resultatsParReseau[cleErreur] = erreurReseau.message;
          }
        }

        const auMoinsUnSucces = Object.keys(resultatsParReseau).some(k => !k.endsWith('erreur'));
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_social_posts`, {
          method: 'POST',
          headers: { ...supaHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify([{
            draft_id: draftId,
            photo_url: photoUrl,
            legende: legendeComplete,
            hashtags,
            reseaux_cibles: reseaux,
            genere_par_ia: true,
            statut: auMoinsUnSucces ? 'publie' : 'erreur',
            published_at: auMoinsUnSucces ? new Date().toISOString() : null,
            ...resultatsParReseau,
          }]),
        });

        resultats.traites++;
        if (auMoinsUnSucces) resultats.publies++;
      } catch (erreurArtisan) {
        resultats.erreurs.push({ draftId, erreur: erreurArtisan.message });
      }
    }

    return res.status(200).json({ success: true, ...resultats });
  } catch (err) {
    console.error('Erreur agent-reseaux-sociaux :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
