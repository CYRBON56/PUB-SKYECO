// /api/definir-repartition-budget-meta.js
// Permet à l'artisan de choisir depuis mon-dashboard.html la part (en %) de
// son budget publicitaire déjà payé qui va sur Meta Ads (Facebook/Instagram),
// le reste continuant d'aller sur Google Ads — demandé par Cyrille le
// 14/09/2026 : Meta Ads existe côté backend (create-meta-ads-campaign.js)
// mais rien dans le dashboard ne permettait de l'activer ni de le régler.
// Curseur manuel choisi plutôt qu'une répartition pilotée par l'IA, pour
// démarrer simplement.
//
// Calqué sur api/definir-budget-journalier.js : même mécanisme de jeton de
// session signé (voir verifierToken ci-dessous et le commentaire de sécurité
// du 06/09/2026 dans ce fichier) — ce réglage change une vraie campagne
// publicitaire, il ne doit pas être modifiable sur simple présentation d'un
// draftId non secret.
//
// Enregistre budget_repartition_meta_pourcent (0-100) sur le brouillon, puis,
// si la part passe au-dessus de 0% ET qu'un budget publicitaire est déjà
// actif (tarif_actif), déclenche immédiatement create-meta-ads-campaign.js
// en interne (serveur-à-serveur) pour que le changement prenne effet tout de
// suite plutôt que d'attendre le prochain rechargement de budget.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

// Sécurité (calquée sur definir-budget-journalier.js, 06/09/2026) : voir
// api/bloquer-creneau.js — jamais de changement de campagne réelle sur
// simple présentation d'un draftId non secret.
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
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token, pourcentageMeta } = req.body || {};
  const pourcentage = parseInt(pourcentageMeta, 10);
  if (!draftId || !token || Number.isNaN(pourcentage) || pourcentage < 0 || pourcentage > 100) {
    return res.status(400).json({ success: false, error: 'draftId, token et pourcentageMeta (0 à 100) requis.' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'session_invalide' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ budget_repartition_meta_pourcent: pourcentage }),
    });

    let campagneCreee = false;
    let campagneMessage = null;

    if (pourcentage > 0) {
      const draftResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=tarif_actif`,
        { headers: supaHeaders }
      );
      const rows = await draftResp.json();
      const tarifActif = rows[0]?.tarif_actif;

      if (tarifActif) {
        try {
          const origin = req.headers.origin || `https://${req.headers.host}`;
          const campagneResp = await fetch(`${origin}/api/create-meta-ads-campaign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draft_id: draftId }),
          });
          const campagneData = await campagneResp.json();
          if (campagneResp.ok) {
            campagneCreee = true;
          } else {
            console.error('Campagne Meta Ads non créée après changement de répartition :', JSON.stringify(campagneData));
            campagneMessage = campagneData.error || "La campagne n'a pas pu être créée automatiquement.";
          }
        } catch (campagneErr) {
          console.error('Erreur appel création campagne Meta Ads :', campagneErr);
          campagneMessage = "La campagne n'a pas pu être créée automatiquement.";
        }
      } else {
        campagneMessage = 'La répartition est enregistrée — la campagne Meta Ads démarrera dès votre prochain approvisionnement de budget.';
      }
    }

    return res.status(200).json({ success: true, pourcentageMeta: pourcentage, campagneCreee, campagneMessage });
  } catch (err) {
    console.error('Erreur definir-repartition-budget-meta :', err);
    return res.status(500).json({ success: false, error: "Impossible d'enregistrer la répartition pour le moment." });
  }
}
