// /api/devis-gestion.js
//
// Endpoint unique pour le module Devis/Facture natif (10/09/2026), sur le
// meme principe que api/leads-admin.js : toutes les actions passent par ici,
// cote serveur, avec la cle service_role — jamais d'ecriture directe depuis
// le navigateur sur skyeco_pro_produits / skyeco_pro_devis (donnees client).
//
// Requete attendue : POST { action, draftId, token, ...params }
// Reponse : { success: true, ... } ou { success: false, error }
//
// Actions disponibles :
//   'produits_liste'      { draftId, token }
//   'produit_sauver'      { draftId, token, produit: { id?, nom, description?, unite, prixHt, tvaTaux } }
//   'produit_supprimer'   { draftId, token, produitId }
//   'devis_liste'         { draftId, token, leadId? }  -- leadId filtre sur un seul client
//   'devis_get'           { draftId, token, devisId }
//   'devis_sauver'        { draftId, token, devis: { id?, leadId?, clientNom, clientEmail?, clientTelephone?, clientAdresse?, lignes: [...] } }
//   'devis_supprimer'     { draftId, token, devisId }
//   'devis_facturer'      { draftId, token, devisId }
//   'lead_infos'          { draftId, token, leadId }  -- coordonnees d'un lead, pour pre-remplir un nouveau devis
//
// Important (rappel legal, voir sql-creation-devis.sql) : cet outil ne suit
// JAMAIS le paiement/encaissement d'une facture — uniquement la generation
// du document. Ne pas ajouter de champ "paye" suivi automatiquement sans
// revalider la question de la certification NF525.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supaHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// --- Verification de session : identique a api/mes-leads.js / api/envoyer-devis.js
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
        `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftIdAttendu}&select=email`,
        { headers: supaHeaders() }
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

const UNITES_VALIDES = new Set(['m2', 'ml', 'm3', 'forfait', 'heure', 'unite']);

// Lu et appliqué côté serveur (jamais fait confiance au client) : un
// artisan en franchise en base de TVA (auto-entrepreneur) ne doit JAMAIS
// pouvoir se retrouver avec une TVA facturée sur un devis, même si le
// navigateur envoyait par erreur/manipulation une valeur non nulle.
async function estFranchiseTva(draftId) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=franchise_tva`,
    { headers: supaHeaders() }
  );
  const rows = await resp.json();
  return !!(rows[0] && rows[0].franchise_tva);
}

function calculerTotaux(lignes) {
  let totalHt = 0, totalTva = 0;
  for (const l of lignes) {
    const q = Number(l.quantite) || 0;
    const pu = Number(l.prixUnitaireHt ?? l.prix_unitaire_ht) || 0;
    const tva = Number(l.tvaTaux ?? l.tva_taux) || 0;
    const ligneHt = q * pu;
    totalHt += ligneHt;
    totalTva += ligneHt * (tva / 100);
  }
  totalHt = Math.round(totalHt * 100) / 100;
  totalTva = Math.round(totalTva * 100) / 100;
  const totalTtc = Math.round((totalHt + totalTva) * 100) / 100;
  return { totalHt, totalTva, totalTtc };
}

function normaliserLignes(lignesBrutes) {
  if (!Array.isArray(lignesBrutes)) return [];
  return lignesBrutes
    .filter(l => l && typeof l.nom === 'string' && l.nom.trim())
    .slice(0, 100)
    .map(l => ({
      produit_id: l.produitId || l.produit_id || null,
      nom: String(l.nom).trim().substring(0, 120),
      description: l.description ? String(l.description).trim().substring(0, 500) : null,
      quantite: Number(l.quantite) > 0 ? Number(l.quantite) : 1,
      unite: UNITES_VALIDES.has(l.unite) ? l.unite : 'forfait',
      prix_unitaire_ht: Number(l.prixUnitaireHt ?? l.prix_unitaire_ht) || 0,
      tva_taux: [0, 5.5, 10, 20].includes(Number(l.tvaTaux ?? l.tva_taux)) ? Number(l.tvaTaux ?? l.tva_taux) : 20,
    }));
}

// Jour de l'annee (1-366), fuseau Europe/Paris
function jourDeLAnnee(date) {
  const debut = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const diff = date - debut;
  return Math.floor(diff / 86400000) + 1;
}

// Numero devis AAAA-JJJ-NN : NN repart a 00 chaque jour, PAR ARTISAN (draft_id).
async function genererNumeroDevis(draftId) {
  const maintenant = new Date();
  const annee = maintenant.getUTCFullYear();
  const jour = jourDeLAnnee(maintenant);
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?draft_id=eq.${draftId}&type=eq.devis&jour_annee=eq.${jour}&select=compteur_jour&order=compteur_jour.desc&limit=1`,
    { headers: supaHeaders() }
  );
  const rows = await resp.json();
  const compteur = rows.length ? rows[0].compteur_jour + 1 : 0;
  const numero = `${annee}-${String(jour).padStart(3, '0')}-${String(compteur).padStart(2, '0')}`;
  return { numero, jourAnnee: jour, compteurJour: compteur };
}

// Numero facture : compteur sequentiel continu, sans trou, PAR ARTISAN.
// Obligation legale -> jamais de saut, jamais de reutilisation d'un numero.
async function genererNumeroFacture(draftId) {
  const annee = new Date().getUTCFullYear();
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?draft_id=eq.${draftId}&type=eq.facture&select=numero&order=created_at.desc&limit=1`,
    { headers: supaHeaders() }
  );
  const rows = await resp.json();
  let prochain = 1;
  if (rows.length) {
    const m = String(rows[0].numero || '').match(/(\d+)$/);
    if (m) prochain = parseInt(m[1], 10) + 1;
  }
  return `F-${annee}-${String(prochain).padStart(4, '0')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Methode non autorisee' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !process.env.DASHBOARD_SESSION_SECRET) {
    return res.status(500).json({ success: false, error: 'Configuration serveur incomplete.' });
  }

  const { action, draftId, token } = req.body || {};
  if (!action || !draftId || !token) {
    return res.status(400).json({ success: false, error: 'Parametres manquants.' });
  }
  const autorise = await verifierToken(token, draftId);
  if (!autorise) {
    return res.status(401).json({ success: false, error: 'Session invalide ou expiree.' });
  }

  try {
    switch (action) {

      case 'produits_liste': {
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_produits?draft_id=eq.${draftId}&select=*&order=nom.asc`,
          { headers: supaHeaders() }
        );
        const produits = await resp.json();
        return res.status(200).json({ success: true, produits });
      }

      case 'produit_sauver': {
        const p = req.body.produit || {};
        if (!p.nom || !String(p.nom).trim()) {
          return res.status(400).json({ success: false, error: 'Le nom du produit est requis.' });
        }
        const franchiseProduit = await estFranchiseTva(draftId);
        const donnees = {
          draft_id: draftId,
          nom: String(p.nom).trim().substring(0, 120),
          description: p.description ? String(p.description).trim().substring(0, 500) : null,
          unite: UNITES_VALIDES.has(p.unite) ? p.unite : 'forfait',
          prix_ht: Number(p.prixHt) || 0,
          tva_taux: franchiseProduit ? 0 : ([0, 5.5, 10, 20].includes(Number(p.tvaTaux)) ? Number(p.tvaTaux) : 20),
        };
        let resp;
        if (p.id) {
          resp = await fetch(
            `${SUPABASE_URL}/rest/v1/skyeco_pro_produits?id=eq.${p.id}&draft_id=eq.${draftId}`,
            { method: 'PATCH', headers: supaHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(donnees) }
          );
        } else {
          resp = await fetch(
            `${SUPABASE_URL}/rest/v1/skyeco_pro_produits`,
            { method: 'POST', headers: supaHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(donnees) }
          );
        }
        if (!resp.ok) throw new Error(await resp.text());
        const rows = await resp.json();
        return res.status(200).json({ success: true, produit: rows[0] });
      }

      case 'produit_supprimer': {
        const { produitId } = req.body;
        if (!produitId) return res.status(400).json({ success: false, error: 'produitId manquant.' });
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_produits?id=eq.${produitId}&draft_id=eq.${draftId}`,
          { method: 'DELETE', headers: supaHeaders() }
        );
        if (!resp.ok) throw new Error(await resp.text());
        return res.status(200).json({ success: true });
      }

      case 'devis_liste': {
        const { leadId } = req.body;
        const filtreLead = leadId ? `&lead_id=eq.${leadId}` : '';
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?draft_id=eq.${draftId}${filtreLead}&select=id,type,statut,numero,client_nom,total_ttc,devis_origine_id,lead_id,created_at&order=created_at.desc`,
          { headers: supaHeaders() }
        );
        const documents = await resp.json();
        return res.status(200).json({ success: true, documents });
      }

      case 'lead_infos': {
        const { leadId } = req.body;
        if (!leadId) return res.status(400).json({ success: false, error: 'leadId manquant.' });
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&draft_id=eq.${draftId}&select=id,prenom,nom,telephone,email,reponses`,
          { headers: supaHeaders() }
        );
        const rows = await resp.json();
        if (!rows.length) return res.status(404).json({ success: false, error: 'Client introuvable.' });
        const l = rows[0];
        const reponses = l.reponses || {};
        const adresse = reponses.adresse
          || Object.entries(reponses).find(([k]) => /adresse|address|localisation|ville/i.test(k))?.[1]
          || null;
        // Pas de prix a recuperer ici : Skyeco Ads n'associe plus de chiffrage
        // automatique aux demandes (moteur retire le 04/09/2026) — seules les
        // reponses brutes du formulaire existent. On les formate en texte
        // lisible pour que l'artisan les ait sous les yeux en creant les
        // lignes du devis lui-meme, sans jamais inventer de prix.
        const contexte = Object.entries(reponses)
          .filter(([k, v]) => v !== null && v !== '' && !/adresse|address|localisation/i.test(k))
          .map(([k, v]) => `${k} : ${v}`)
          .join(' — ');
        return res.status(200).json({
          success: true,
          lead: {
            nomComplet: `${l.prenom || ''} ${l.nom || ''}`.trim(),
            telephone: l.telephone || '',
            email: l.email || '',
            adresse: adresse || '',
            contexte,
          },
        });
      }

      case 'devis_get': {
        const { devisId } = req.body;
        if (!devisId) return res.status(400).json({ success: false, error: 'devisId manquant.' });
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?id=eq.${devisId}&draft_id=eq.${draftId}&select=*`,
          { headers: supaHeaders() }
        );
        const rows = await resp.json();
        if (!rows.length) return res.status(404).json({ success: false, error: 'Document introuvable.' });
        return res.status(200).json({ success: true, document: rows[0] });
      }

      case 'devis_sauver': {
        const d = req.body.devis || {};
        if (!d.clientNom || !String(d.clientNom).trim()) {
          return res.status(400).json({ success: false, error: 'Le nom du client est requis.' });
        }
        const franchise = await estFranchiseTva(draftId);
        let lignes = normaliserLignes(d.lignes);
        if (franchise) lignes = lignes.map(l => ({ ...l, tva_taux: 0 }));
        const { totalHt, totalTva, totalTtc } = calculerTotaux(lignes);
        const donneesCommunes = {
          client_nom: String(d.clientNom).trim().substring(0, 120),
          client_email: d.clientEmail ? String(d.clientEmail).trim().substring(0, 160) : null,
          client_telephone: d.clientTelephone ? String(d.clientTelephone).trim().substring(0, 30) : null,
          client_adresse: d.clientAdresse ? String(d.clientAdresse).trim().substring(0, 300) : null,
          lignes,
          total_ht: totalHt,
          total_tva: totalTva,
          total_ttc: totalTtc,
          updated_at: new Date().toISOString(),
        };

        if (d.id) {
          // Modification d'un devis existant — on ne touche jamais une facture ici.
          const existant = await fetch(
            `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?id=eq.${d.id}&draft_id=eq.${draftId}&select=type`,
            { headers: supaHeaders() }
          ).then(r => r.json());
          if (!existant.length) return res.status(404).json({ success: false, error: 'Devis introuvable.' });
          if (existant[0].type !== 'devis') {
            return res.status(400).json({ success: false, error: 'Une facture ne peut pas etre modifiee ici.' });
          }
          const resp = await fetch(
            `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?id=eq.${d.id}&draft_id=eq.${draftId}`,
            { method: 'PATCH', headers: supaHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(donneesCommunes) }
          );
          if (!resp.ok) throw new Error(await resp.text());
          const rows = await resp.json();
          return res.status(200).json({ success: true, document: rows[0] });
        } else {
          const { numero, jourAnnee, compteurJour } = await genererNumeroDevis(draftId);
          const resp = await fetch(
            `${SUPABASE_URL}/rest/v1/skyeco_pro_devis`,
            {
              method: 'POST',
              headers: supaHeaders({ Prefer: 'return=representation' }),
              body: JSON.stringify({
                draft_id: draftId,
                lead_id: d.leadId || null,
                type: 'devis',
                statut: 'brouillon',
                numero,
                jour_annee: jourAnnee,
                compteur_jour: compteurJour,
                ...donneesCommunes,
              }),
            }
          );
          if (!resp.ok) throw new Error(await resp.text());
          const rows = await resp.json();
          return res.status(200).json({ success: true, document: rows[0] });
        }
      }

      case 'devis_supprimer': {
        const { devisId } = req.body;
        if (!devisId) return res.status(400).json({ success: false, error: 'devisId manquant.' });
        const existant = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?id=eq.${devisId}&draft_id=eq.${draftId}&select=type`,
          { headers: supaHeaders() }
        ).then(r => r.json());
        if (!existant.length) return res.status(404).json({ success: false, error: 'Document introuvable.' });
        if (existant[0].type === 'facture') {
          return res.status(400).json({ success: false, error: 'Une facture ne peut jamais etre supprimee (obligation legale) — seul un avoir peut la corriger.' });
        }
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?id=eq.${devisId}&draft_id=eq.${draftId}`,
          { method: 'DELETE', headers: supaHeaders() }
        );
        if (!resp.ok) throw new Error(await resp.text());
        return res.status(200).json({ success: true });
      }

      case 'devis_facturer': {
        const { devisId } = req.body;
        if (!devisId) return res.status(400).json({ success: false, error: 'devisId manquant.' });
        const rows = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?id=eq.${devisId}&draft_id=eq.${draftId}&select=*`,
          { headers: supaHeaders() }
        ).then(r => r.json());
        if (!rows.length) return res.status(404).json({ success: false, error: 'Devis introuvable.' });
        const devisOrigine = rows[0];
        if (devisOrigine.type !== 'devis') {
          return res.status(400).json({ success: false, error: 'Ce document est deja une facture.' });
        }
        const numeroFacture = await genererNumeroFacture(draftId);
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_devis`,
          {
            method: 'POST',
            headers: supaHeaders({ Prefer: 'return=representation' }),
            body: JSON.stringify({
              draft_id: draftId,
              lead_id: devisOrigine.lead_id || null,
              type: 'facture',
              statut: 'emise',
              numero: numeroFacture,
              devis_origine_id: devisOrigine.id,
              client_nom: devisOrigine.client_nom,
              client_email: devisOrigine.client_email,
              client_telephone: devisOrigine.client_telephone,
              client_adresse: devisOrigine.client_adresse,
              lignes: devisOrigine.lignes,
              total_ht: devisOrigine.total_ht,
              total_tva: devisOrigine.total_tva,
              total_ttc: devisOrigine.total_ttc,
            }),
          }
        );
        if (!resp.ok) throw new Error(await resp.text());
        const factureRows = await resp.json();
        // Marque le devis d'origine comme facture, sans le supprimer (historique conserve).
        await fetch(
          `${SUPABASE_URL}/rest/v1/skyeco_pro_devis?id=eq.${devisOrigine.id}`,
          { method: 'PATCH', headers: supaHeaders(), body: JSON.stringify({ statut: 'facture' }) }
        );
        return res.status(200).json({ success: true, document: factureRows[0] });
      }

      default:
        return res.status(400).json({ success: false, error: 'Action inconnue.' });
    }
  } catch (err) {
    console.error('Erreur devis-gestion :', err);
    return res.status(500).json({ success: false, error: "Erreur serveur — reessaie dans un instant." });
  }
}
