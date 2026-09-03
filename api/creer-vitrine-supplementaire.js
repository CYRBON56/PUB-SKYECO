// /api/creer-vitrine-supplementaire.js
// Permet à un artisan DÉJÀ CONNECTÉ (compte existant, identité déjà
// vérifiée par SMS lors de sa toute première inscription) de créer une
// NOUVELLE vitrine — par exemple pour une activité ou un produit différent
// — sans repasser par le formulaire d'inscription complet ni revérifier
// son téléphone. Les informations d'identité de l'entreprise (SIRET,
// téléphone, forme juridique, adresse...) sont reprises du site source ;
// seul le nom affiché de la nouvelle vitrine peut être personnalisé.
//
// Le mot de passe du compte est copié directement sur la nouvelle ligne :
// elle est donc immédiatement accessible depuis le même tableau de bord
// (sélecteur de site), sans passer par acces-dashboard.html. Comme
// aujourd'hui, chaque vitrine reste facturée séparément (son propre
// forfait / abonnement) — cet endpoint ne fait que créer le brouillon, pas
// l'abonnement : l'artisan continue ensuite vers mes-elements.html puis
// contrat.html / choisir-forfait.html pour cette nouvelle vitrine, comme
// pour une inscription normale.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

function decoderToken(token) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return null;
    const [emailB64, role, expStr, sig] = parties;
    if (role !== 'artisan') return null;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return null;

    const payload = `${emailB64}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return null;

    return Buffer.from(emailB64, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }
  const { draftIdSource, token, nomVitrine } = req.body || {};
  if (!draftIdSource || !token) {
    return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
  }

  const email = decoderToken(token);
  if (!email) {
    return res.status(401).json({ success: false, error: 'Session invalide.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Le site source DOIT appartenir au même compte (email du jeton) — on
    // ne fait confiance qu'à cette vérification serveur, jamais au corps de
    // la requête seul.
    const sourceResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftIdSource}&select=siret,entreprise,zone,telephone,email,forme_juridique,date_creation_entreprise,code_naf,libelle_activite,adresse_rue,adresse_cp,adresse_ville,departement,dashboard_password_hash`,
      { headers: supaHeaders }
    );
    const sourceRows = await sourceResp.json();
    const source = sourceRows[0];
    if (!source || !source.email || source.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Site source introuvable pour ce compte.' });
    }

    const nouveauSite = {
      siret: source.siret,
      entreprise: (nomVitrine && nomVitrine.trim()) || source.entreprise,
      zone: source.zone,
      telephone: source.telephone,
      email: source.email,
      forme_juridique: source.forme_juridique,
      date_creation_entreprise: source.date_creation_entreprise,
      code_naf: source.code_naf,
      libelle_activite: source.libelle_activite,
      adresse_rue: source.adresse_rue,
      adresse_cp: source.adresse_cp,
      adresse_ville: source.adresse_ville,
      departement: source.departement,
      status: 'preview',
      dashboard_password_hash: source.dashboard_password_hash || null,
      dashboard_compte_cree_le: source.dashboard_password_hash ? new Date().toISOString() : null,
    };

    const createResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts`, {
      method: 'POST',
      headers: { ...supaHeaders, Prefer: 'return=representation' },
      body: JSON.stringify([nouveauSite]),
    });
    if (!createResp.ok) throw new Error('Échec de la création de la nouvelle vitrine.');
    const created = await createResp.json();
    const nouveauDraftId = created[0]?.id;
    if (!nouveauDraftId) throw new Error('Création réussie mais identifiant manquant.');

    return res.status(200).json({ success: true, draftId: nouveauDraftId });
  } catch (err) {
    console.error('Erreur creer-vitrine-supplementaire :', err);
    return res.status(500).json({ success: false, error: 'Impossible de créer la nouvelle vitrine pour le moment.' });
  }
}
