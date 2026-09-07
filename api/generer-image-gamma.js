// api/generer-image-gamma.js
//
// Deux actions selon le body :
//   { action: "start", prompt, draftId }              -> lance une génération d'image chez Gamma
//   { action: "status", generationId, draftId }        -> vérifie l'avancement ; une fois prête,
//                                                          télécharge l'image et la ré-uploade dans
//                                                          Supabase Storage (URL permanente, jamais
//                                                          l'URL Gamma qui expire au bout de quelques jours)
//
// Variable d'environnement requise sur Vercel : GAMMA_API_KEY
//
// Endpoints vérifiés le 07/09/2026 sur https://developers.gamma.app :
//   POST /v1.0/images       -> lance la génération, renvoie { imageGenerationId }
//   GET  /v1.0/images/{id}  -> statut ; une fois "completed", renvoie image.url

const GAMMA_API_BASE = 'https://public-api.gamma.app/v1.0';

const SUPABASE_URL = 'https://wklddwumirkdjkbxvzyj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrbGRkd3VtaXJrZGprYnh2enlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMTMzNDksImV4cCI6MjA5ODc4OTM0OX0._2cVv3rmhHb-7VLTCqiMRq0F2S30NMnD8qRhTiBM7nc';
const BUCKET = 'skyeco-pro-media';

async function demarrerGeneration(prompt) {
  const resp = await fetch(`${GAMMA_API_BASE}/images`, {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.GAMMA_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      sizePreset: 'banner', // format large, adapté à un carrousel de vitrine
      type: 'photo',
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Gamma a refusé la demande (${resp.status}) : ${detail}`);
  }
  return resp.json(); // attendu : { imageGenerationId, status }
}

async function verifierStatut(generationId) {
  const resp = await fetch(`${GAMMA_API_BASE}/images/${generationId}`, {
    headers: { 'X-API-KEY': process.env.GAMMA_API_KEY },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Impossible de vérifier le statut (${resp.status}) : ${detail}`);
  }
  return resp.json(); // attendu : { status: "pending"|"completed"|"failed", url? }
}

// Télécharge l'image générée chez Gamma et la ré-uploade dans le stockage
// Supabase du site — même logique que uploaderFichier() côté front, pour que
// l'image survive même si Gamma supprime les fichiers temporaires plus tard.
async function copierVersSupabase(urlImageGamma, draftId) {
  const imgResp = await fetch(urlImageGamma);
  if (!imgResp.ok) throw new Error("Impossible de récupérer l'image générée");
  const buffer = Buffer.from(await imgResp.arrayBuffer());
  const contentType = imgResp.headers.get('content-type') || 'image/png';
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const nomFichier = `elements-artisan/${draftId}/photo-ia-${Date.now()}.${ext}`;

  const upResp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${nomFichier}?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': contentType,
      },
      body: buffer,
    }
  );
  if (!upResp.ok) {
    const detail = await upResp.text().catch(() => '');
    throw new Error("Échec de l'enregistrement de l'image dans le stockage : " + detail);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${nomFichier}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  if (!process.env.GAMMA_API_KEY) {
    return res.status(500).json({ success: false, error: 'GAMMA_API_KEY manquante côté serveur' });
  }

  try {
    const { action, prompt, generationId, draftId } = req.body || {};

    if (action === 'start') {
      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ success: false, error: 'Prompt vide' });
      }
      const result = await demarrerGeneration(prompt.trim());
      return res.status(200).json({ success: true, generationId: result.imageGenerationId });
    }

    if (action === 'status') {
      if (!generationId) {
        return res.status(400).json({ success: false, error: 'generationId manquant' });
      }
      const result = await verifierStatut(generationId);

      if (result.status === 'completed' && result.image && result.image.url) {
        const urlPermanente = await copierVersSupabase(result.image.url, draftId || 'sans-id');
        return res.status(200).json({ success: true, status: 'completed', url: urlPermanente });
      }
      if (result.status === 'failed') {
        return res.status(200).json({ success: true, status: 'failed', error: result.error || 'Génération échouée' });
      }
      return res.status(200).json({ success: true, status: 'pending' });
    }

    return res.status(400).json({ success: false, error: 'Action inconnue' });
  } catch (e) {
    console.error('Erreur generer-image-gamma :', e);
    return res.status(500).json({ success: false, error: e.message });
  }
}
