// /api/signer-devis.js
// Page publique (voir public/signer-devis.html) permettant à un prospect de
// consulter puis signer son devis, sans compte ni mot de passe : l'accès est
// protégé uniquement par le jeton aléatoire reçu par SMS (voir
// api/envoyer-devis.js). La "signature" est un mécanisme léger — confirmation
// explicite (case à cocher + clic) enregistrée avec horodatage et IP, en plus
// du fait que le numéro de téléphone du prospect a déjà été vérifié par SMS
// lors de sa demande d'estimation (colonne telephone_verifie) — et non une
// signature manuscrite/type DocuSign.
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
    const leadResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?devis_token=eq.${encodeURIComponent(token)}&select=id,draft_id,nom,prenom,devis_pdf_url,devis_statut,devis_envoye_le,devis_signe_le`,
      { headers: supaHeaders }
    );
    const leadRows = await leadResp.json();
    const lead = leadRows[0];
    if (!lead || !lead.devis_pdf_url) {
      return res.status(404).json({ error: 'Ce lien de devis est invalide ou a expiré.' });
    }

    const draftResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${lead.draft_id}&select=entreprise,telephone`,
      { headers: supaHeaders }
    );
    const draftRows = await draftResp.json();
    const entreprise = draftRows[0]?.entreprise || 'Votre artisan';

    if (req.method === 'GET') {
      return res.status(200).json({
        success: true,
        entreprise,
        nomClient: [lead.prenom, lead.nom].filter(Boolean).join(' '),
        pdfUrl: lead.devis_pdf_url,
        statut: lead.devis_statut,
        signeLe: lead.devis_signe_le,
      });
    }

    if (req.method === 'POST') {
      if (lead.devis_statut === 'signe') {
        // Idempotent : redonne simplement la confirmation déjà enregistrée.
        return res.status(200).json({ success: true, dejaSigne: true, signeLe: lead.devis_signe_le });
      }

      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
      const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${lead.id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          devis_statut: 'signe',
          devis_signe_le: new Date().toISOString(),
          devis_ip_signature: ip,
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
    console.error('Erreur signer-devis :', err);
    return res.status(500).json({ error: err.message || "Une erreur est survenue." });
  }
}
