// /api/marketplace-confirmer-achat.js
// Étape 2 de l'achat d'un contact marketplace : appelé par mon-dashboard.html
// juste après le retour de Stripe Checkout (voir success_url dans
// api/marketplace-reserver-lead.js), même schéma que
// api/confirm-ad-payment.js pour le budget publicitaire — on ne dépend PAS
// uniquement d'un webhook Stripe pour ce paiement ponctuel.
//
// Idempotent : un rechargement de page avec le même marketplace_session_id
// ne recrée pas un deuxième lead (voir le cas "déjà vendu à ce même
// artisan" ci-dessous).
//
// Ce qui se passe une fois le paiement confirmé :
//   1. Une copie du contact est insérée dans skyeco_pro_leads avec
//      draft_id = l'artisan acheteur — il apparaît alors automatiquement
//      dans "Gérer les clients" (api/mes-leads.js), sans code dashboard
//      supplémentaire.
//   2. Le lead marketplace est marqué "vendu".
//   3. Cyrille (admin) est notifié de la vente.
//
// Requête attendue : POST { draftId, token, sessionId }
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, ADMIN_PHONE (notif admin, optionnel)

import Stripe from 'stripe';
import { verifierToken } from './_lib/marketplace-auth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

async function notifierAdminSMS(texte) {
  if (!ADMIN_PHONE) return;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) return;
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: ADMIN_PHONE, From: from, Body: texte }),
    });
  } catch (e) {
    console.error('Erreur notif admin marketplace-confirmer-achat :', e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { draftId, token, sessionId } = req.body || {};
  if (!draftId || !token || !sessionId) {
    return res.status(401).json({ success: false, error: 'non_authentifie' });
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
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ success: false, error: 'Paiement non confirmé.' });
    }
    if (session.metadata?.type !== 'marketplace_lead' || session.metadata?.draft_id !== draftId) {
      return res.status(400).json({ success: false, error: 'Cette session ne correspond pas à cet achat.' });
    }

    const leadId = session.metadata.lead_id;
    const leadResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads_marketplace?id=eq.${leadId}&select=*`,
      { headers: supaHeaders }
    );
    const leadRows = leadResp.ok ? await leadResp.json() : [];
    const lead = leadRows[0];
    if (!lead) {
      return res.status(404).json({ success: false, error: 'Contact introuvable.' });
    }

    // Idempotence : la page a pu être rechargée après un premier succès.
    if (lead.statut === 'vendu') {
      if (lead.vendu_a_draft_id === draftId) {
        return res.status(200).json({
          success: true,
          message: 'Achat déjà confirmé — ce contact est dans votre liste de clients.',
          leadId: lead.lead_id_genere,
        });
      }
      // Ne devrait jamais arriver grâce au verrou de marketplace-reserver-lead.js
      // — signalé pour vérification manuelle plutôt que silencieusement ignoré.
      console.error(`Conflit marketplace : session ${sessionId} payée par draft ${draftId} mais lead ${leadId} déjà vendu à ${lead.vendu_a_draft_id}`);
      return res.status(409).json({ success: false, error: 'Ce contact a déjà été attribué à un autre artisan — contactez le support, votre paiement sera vérifié.' });
    }

    if (lead.statut !== 'reserve' || lead.reserve_par_draft_id !== draftId || lead.stripe_checkout_session_id !== sessionId) {
      return res.status(400).json({ success: false, error: 'Session de paiement invalide pour ce contact.' });
    }

    // 1. Copie le contact dans skyeco_pro_leads, attribué à l'artisan acheteur.
    const insertResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads`, {
      method: 'POST',
      headers: { ...supaHeaders, Prefer: 'return=representation' },
      body: JSON.stringify([{
        draft_id: draftId,
        nom: lead.nom,
        prenom: lead.prenom,
        telephone: lead.telephone,
        telephone_verifie: lead.telephone_verifie,
        email: lead.email,
        reponses: {
          ...(lead.reponses || {}),
          source: 'marketplace_skyeco',
          marketplace_prix_ttc: lead.prix_cts / 100,
          marketplace_commune: lead.commune,
          marketplace_type_projet: lead.type_projet,
        },
        statut: 'nouveau',
      }]),
    });
    if (!insertResp.ok) {
      const errData = await insertResp.json().catch(() => ({}));
      console.error('Erreur copie lead marketplace -> skyeco_pro_leads :', JSON.stringify(errData));
      return res.status(500).json({ success: false, error: 'Paiement confirmé mais contact non attribué — contactez le support.' });
    }
    const insertData = await insertResp.json().catch(() => []);
    const nouveauLeadId = insertData[0]?.id || null;

    // 2. Marque le lead marketplace comme vendu.
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads_marketplace?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        statut: 'vendu',
        vendu_a_draft_id: draftId,
        vendu_le: new Date().toISOString(),
        lead_id_genere: nouveauLeadId,
        reserve_expire_at: null,
      }),
    });

    // 3. Notifie Cyrille (best-effort, n'affecte pas la réponse au client).
    await notifierAdminSMS(
      `💰 Vente marketplace Skyeco : contact ${lead.commune || 'Morbihan'} (${(lead.prix_cts / 100).toFixed(2)}€) vendu via mon-dashboard.html (draft ${draftId}).`
    );

    return res.status(200).json({
      success: true,
      message: 'Contact débloqué — il apparaît maintenant dans "Gérer les clients".',
      leadId: nouveauLeadId,
    });
  } catch (err) {
    console.error('Erreur marketplace-confirmer-achat :', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
