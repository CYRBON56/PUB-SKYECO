// /api/signer-mon-devis.js
// Page publique (voir public/signer-mon-devis.html) permettant à un client
// de consulter puis signer un devis créé depuis le module Devis & Factures
// natif (skyeco_pro_devis) — pendant de api/signer-devis.js, qui lui
// s'applique aux devis envoyés depuis le flux "lead" (skyeco_pro_leads).
//
// Contrairement à l'ancien flux, aucun PDF externe n'est nécessaire : le
// devis est entièrement stocké en base (lignes, totaux) et rendu en HTML
// directement par la page publique — plus simple, rien à héberger ailleurs.
//
// Accès protégé uniquement par le jeton aléatoire (skyeco_pro_devis.devis_token),
// envoyé par SMS (voir action 'devis_envoyer_sms_signature' de
// api/devis-gestion.js). La "signature" est une confirmation explicite
// (case à cocher + clic), horodatée et associée à l'IP — pas une signature
// manuscrite/type DocuSign.
//
// GET  ?t=<token>   -> renvoie les infos du devis (lecture seule)
// POST { token }    -> enregistre la signature (idempotent)
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  const token = req.method === 'GET' ? req.query?.t : (req.body || {}).token;
  if (!token) {
    return res.status(400).json({ error: 'Jeton manquant.' });
  }

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_devis?devis_token=eq.${encodeURIComponent(token)}&select=id,draft_id,type,numero,client_nom,client_adresse,lignes,total_ht,total_tva,total_ttc,statut,signe_le,created_at`,
      { headers: supaHeaders }
    );
    const rows = await resp.json();
    const d = rows[0];
    if (!d) {
      return res.status(404).json({ error: 'Ce lien de devis est invalide ou a expiré.' });
    }

    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${d.draft_id}&select=entreprise,telephone,email,franchise_tva,logo_url`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const entreprise = draftRows[0] || {};

    if (req.method === 'GET') {
      return res.status(200).json({
        success: true,
        entreprise: entreprise.entreprise || 'Votre artisan',
        logoUrl: entreprise.logo_url || null,
        type: d.type,
        numero: d.numero,
        clientNom: d.client_nom,
        clientAdresse: d.client_adresse,
        lignes: d.lignes || [],
        totalHt: d.total_ht,
        totalTva: d.total_tva,
        totalTtc: d.total_ttc,
        franchiseTva: !!entreprise.franchise_tva,
        statut: d.statut,
        signeLe: d.signe_le,
        creeLe: d.created_at,
      });
    }

    if (req.method === 'POST') {
      if (d.signe_le) {
        // Idempotent : redonne simplement la confirmation déjà enregistrée.
        return res.status(200).json({ success: true, dejaSigne: true, signeLe: d.signe_le });
      }

      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
      const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_devis?id=eq.${d.id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          signe_le: new Date().toISOString(),
          ip_signature: ip,
          statut: 'signe',
        }),
      });
      if (!patchResp.ok) {
        const errData = await patchResp.text().catch(() => '');
        throw new Error(`Échec de l'enregistrement de la signature : ${errData}`);
      }

      return res.status(200).json({ success: true, signeLe: new Date().toISOString() });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error('Erreur signer-mon-devis :', err);
    return res.status(500).json({ error: err.message || 'Une erreur est survenue.' });
  }
}
