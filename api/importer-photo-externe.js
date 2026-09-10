// /api/importer-photo-externe.js
// Télécharge côté serveur une image trouvée sur le site web existant d'un
// artisan (voir api/generer-vitrine-depuis-site.js) et la réhéberge sur le
// bucket Supabase Storage déjà utilisé pour les photos de mes-elements.html
// — nécessaire car le navigateur ne peut pas récupérer directement les
// octets d'une image sur un domaine externe (CORS) pour la réenvoyer.
//
// Ne modifie jamais le brouillon lui-même : renvoie juste l'URL hébergée,
// c'est le front (mes-elements.html) qui l'ajoute au tableau "photos" et
// l'enregistre, exactement comme un upload manuel classique.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const BUCKET = 'skyeco-pro-media';
const TAILLE_MAX = 8 * 1024 * 1024; // 8 Mo

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, imageUrl } = req.body || {};
  if (!draftId || !imageUrl) {
    return res.status(400).json({ success: false, error: 'draftId ou imageUrl manquant' });
  }

  try {
    const resp = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (SkyecoProBot)' } });
    if (!resp.ok) {
      return res.status(200).json({ success: false, error: "Impossible de récupérer cette image." });
    }
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return res.status(200).json({ success: false, error: "Ce fichier n'est pas une image." });
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > TAILLE_MAX) {
      return res.status(200).json({ success: false, error: 'Image trop volumineuse (max 8 Mo).' });
    }

    const ext = (contentType.split('/')[1] || 'jpg').split(';')[0];
    const nomFichier = `elements-artisan/${draftId}/site-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;

    const uploadResp = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${nomFichier}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': contentType,
        },
        body: buffer,
      }
    );
    if (!uploadResp.ok) {
      const detail = await uploadResp.text().catch(() => '');
      throw new Error("Échec de l'envoi vers le stockage : " + detail);
    }

    return res.status(200).json({
      success: true,
      url: `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${nomFichier}`,
    });
  } catch (err) {
    console.error('Erreur importer-photo-externe :', err);
    return res.status(200).json({ success: false, error: "Cette image n'a pas pu être importée." });
  }
}
