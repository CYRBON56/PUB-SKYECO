// /api/lead-modifier-contact.js
//
// Ajouté le 08/09/2026 (demande de Cyrille) : quand Cyrille saisit LUI-MÊME
// une demande dans apercu.html pour un client déjà eu au téléphone (ou
// rencontré sur un chantier), le formulaire exige une vérification SMS du
// numéro saisi — il ne peut vérifier QUE son propre numéro, pas celui du
// client. La demande enregistrée porte donc le nom du client mais le
// téléphone/email de Cyrille, ce qui le laissait sans aucun moyen de
// recontacter le vrai client depuis le tableau de bord ("Mes clients")
// une fois la demande créée.
//
// Cet endpoint permet de corriger après coup le nom/prénom/téléphone/email
// d'une demande déjà enregistrée — mêmes vérifications d'accès que
// lead-statut.js (jeton de session valide pour LE site propriétaire de cette
// demande précise, avec la clé service_role côté serveur ; skyeco_pro_leads
// n'accepte plus les écritures en clé anonyme depuis le 06/09).
//
// Requête attendue : POST { leadId, token, nom?, prenom?, telephone?, email? }
// (au moins un des 4 champs modifiables) — un champ omis n'est pas touché ;
// une chaîne vide efface le champ (utile si le téléphone saisi n'est
// finalement pas celui du client et qu'on préfère l'effacer plutôt que
// laisser un faux numéro).
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

const CHAMPS_MODIFIABLES = ['nom', 'prenom', 'telephone', 'email'];

async function verifierToken(token, draftIdAttendu) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return false;
    const [sujet, role, expStr, sig] = parties;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return false;
    const payload = `${sujet}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return false;
    if (role === 'admin') return sujet === draftIdAttendu;
    if (role === 'artisan') {
      let email;
      try { email = Buffer.from(sujet, 'base64url').toString('utf8'); } catch (e) { return false; }
      if (!email) return false;
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftIdAttendu}&select=email`,
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const rows = await resp.json();
      const draft = rows[0];
      return !!(draft && draft.email && draft.email.toLowerCase() === email.toLowerCase());
    }
    return false;
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Méthode non autorisée' });

  const { leadId, token, ...champs } = req.body || {};
  if (!leadId || !token) return res.status(400).json({ success: false, error: 'Paramètres manquants' });

  // Ne retient que les champs modifiables réellement fournis (présents dans
  // le corps de la requête) — un champ absent n'est pas touché, une chaîne
  // vide efface le champ.
  const patchBody = {};
  for (const champ of CHAMPS_MODIFIABLES) {
    if (Object.prototype.hasOwnProperty.call(champs, champ)) {
      const valeur = String(champs[champ] ?? '').trim().substring(0, 200);
      patchBody[champ] = valeur || null;
    }
  }
  if (!Object.keys(patchBody).length) {
    return res.status(400).json({ success: false, error: 'Aucun champ à modifier.' });
  }

  const supaHeaders = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };

  try {
    const leadResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&select=draft_id`, { headers: supaHeaders });
    if (!leadResp.ok) throw new Error('Lecture Supabase impossible : ' + (await leadResp.text()));
    const leadRows = await leadResp.json();
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ success: false, error: 'introuvable' });

    if (!(await verifierToken(token, lead.draft_id))) {
      return res.status(401).json({ success: false, error: 'session_invalide' });
    }

    patchBody.updated_at = new Date().toISOString();
    const patch = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patchBody),
    });
    if (!patch.ok) throw new Error('Écriture Supabase impossible : ' + (await patch.text()));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur lead-modifier-contact :', err);
    return res.status(500).json({ success: false, error: "Impossible de mettre à jour ce contact pour le moment." });
  }
}
