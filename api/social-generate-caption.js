// /api/social-generate-caption.js
// Génère une légende Instagram + hashtags à partir de photo(s) et/ou d'une
// courte note fournie par l'artisan sur un chantier. Utilise l'API Anthropic
// (vision) pour "voir" la photo si fournie.
//
// Variables d'environnement requises :
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_ANON_KEY (lecture seule, suffisant ici)
//
// Entrée (POST JSON) :
//   { draftId, photoUrls: string[], note?: string }
// Sortie :
//   { success: true, legende: string, hashtags: string[] }

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Méthode non autorisée." });
    return;
  }

  const { draftId, photoUrls, note } = req.body || {};
  if (!draftId) {
    res.status(400).json({ success: false, error: "draftId manquant." });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  try {
    // Contexte entreprise (nom, zone, métier) pour une légende plus pertinente.
    const draftResp = await fetch(
      `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,zone,metier`,
      { headers: { apikey: SUPABASE_ANON_KEY } }
    );
    const draftRows = await draftResp.json();
    const entreprise = draftRows[0]?.entreprise || "";
    const zone = draftRows[0]?.zone || "";
    const metier = draftRows[0]?.metier || "artisan BTP";

    // Préparer jusqu'à 3 images en base64 pour l'appel vision (limite
    // raisonnable de taille/coût — au-delà, l'IA se base surtout sur la note).
    const imagesAEnvoyer = (Array.isArray(photoUrls) ? photoUrls : []).slice(0, 3);
    const imageBlocks = [];
    for (const url of imagesAEnvoyer) {
      try {
        const imgResp = await fetch(url);
        if (!imgResp.ok) continue;
        const contentType = imgResp.headers.get("content-type") || "image/jpeg";
        const buffer = Buffer.from(await imgResp.arrayBuffer());
        imageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: contentType, data: buffer.toString("base64") },
        });
      } catch (e) {
        // Une photo inaccessible n'empêche pas de continuer avec les autres.
      }
    }

    const promptTexte =
      `Tu rédiges une légende Instagram en français pour ${entreprise || "un artisan"} ` +
      `(${metier}${zone ? `, secteur ${zone}` : ""}). ` +
      (note ? `Note de l'artisan sur ce chantier : "${note}". ` : "") +
      `Regarde la ou les photos jointes du chantier. Écris une légende courte (2-3 phrases), ` +
      `chaleureuse et concrète (mentionne le type de travaux si visible), sans emoji excessif ` +
      `(1-2 maximum). Termine par une liste de 8 à 12 hashtags pertinents (métier, matériaux, ` +
      `ville/région si connue, style de vie). ` +
      `Réponds UNIQUEMENT en JSON strict, sans texte autour, au format : ` +
      `{"legende": "...", "hashtags": ["#exemple1", "#exemple2"]}`;

    const messages = [
      {
        role: "user",
        content: [...imageBlocks, { type: "text", text: promptTexte }],
      },
    ];

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages,
      }),
    });
    const claudeData = await claudeRes.json();
    const texteBrut = claudeData?.content?.find((c) => c.type === "text")?.text || "";

    let parsed;
    try {
      // Retire d'éventuels ```json autour si le modèle en ajoute malgré la consigne.
      const nettoye = texteBrut.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(nettoye);
    } catch (e) {
      throw new Error("Réponse de l'IA illisible : " + texteBrut.slice(0, 200));
    }

    res.status(200).json({
      success: true,
      legende: parsed.legende || "",
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
    });
  } catch (e) {
    console.error("Erreur social-generate-caption:", e);
    res.status(500).json({ success: false, error: "Impossible de générer la légende pour le moment." });
  }
}
