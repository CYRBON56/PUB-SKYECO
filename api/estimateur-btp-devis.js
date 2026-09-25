// /api/estimateur-btp-devis.js
// Historique des devis de l'Estimateur BTP, pour qu'un devis démarré sur un
// téléphone (chantier) soit retrouvable et modifiable depuis l'ordinateur
// (bureau), et inversement — même compte (email) = mêmes devis (25/09/2026).
//
// Ne transporte QUE les lignes du devis (désignations, quantités, prix) et
// les coordonnées du client de CE devis — jamais les photos/vidéos de
// chantier, qui restent volontairement uniquement sur l'appareil qui les a
// prises (annoncé dans l'appli, voir "3. Photos / vidéo du chantier").
//
// Pas de mot de passe ni de jeton de sécurité réel ici — cohérent avec le
// reste de ce produit à 29,90€/mois (email = identifiant), le DELETE et le
// PATCH vérifient simplement que l'email fourni correspond bien au
// propriétaire de la ligne.
//
// GET    ?email=...                 -> liste des devis (plus récents d'abord)
// POST   {email, id?, lignes, ...}  -> crée (sans id) ou met à jour (avec id)
// DELETE ?id=...&email=...          -> supprime un devis
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const supaHeaders = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

function emailValide(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function listerDevis(email) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_devis?email=eq.${encodeURIComponent(email)}&select=*&order=updated_at.desc&limit=200`,
    { headers: supaHeaders }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!emailValide(email)) {
      return res.status(400).json({ success: false, error: 'Email invalide' });
    }
    try {
      const devis = await listerDevis(email);
      return res.status(200).json({ success: true, devis });
    } catch (err) {
      console.error('estimateur-btp-devis GET error:', err.message);
      return res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  }

  if (req.method === 'POST') {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!emailValide(email)) {
      return res.status(400).json({ success: false, error: 'Email invalide' });
    }
    const { id, lignes, client_nom, client_telephone, client_email, client_adresse, total_ht, total_ttc } = req.body || {};

    const donnees = {
      email,
      lignes: lignes || [],
      client_nom: client_nom || null,
      client_telephone: client_telephone || null,
      client_email: client_email || null,
      client_adresse: client_adresse || null,
      total_ht: typeof total_ht === 'number' ? total_ht : null,
      total_ttc: typeof total_ttc === 'number' ? total_ttc : null,
      updated_at: new Date().toISOString(),
    };

    try {
      if (id) {
        // Mise à jour — le filtre sur email empêche de modifier le devis
        // d'un autre compte même si l'id était deviné.
        const resp = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_devis?id=eq.${encodeURIComponent(id)}&email=eq.${encodeURIComponent(email)}`,
          { method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=representation' }, body: JSON.stringify(donnees) }
        );
        if (!resp.ok) throw new Error(await resp.text());
        const rows = await resp.json();
        if (!rows.length) {
          // L'id ne correspond à rien pour cet email (supprimé entre-temps
          // sur un autre appareil, par ex.) — on recrée plutôt que d'échouer.
          const created = await fetch(`${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_devis`, {
            method: 'POST',
            headers: { ...supaHeaders, Prefer: 'return=representation' },
            body: JSON.stringify(donnees),
          });
          if (!created.ok) throw new Error(await created.text());
          const createdRows = await created.json();
          return res.status(200).json({ success: true, id: createdRows[0].id });
        }
        return res.status(200).json({ success: true, id: rows[0].id });
      }

      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_devis`, {
        method: 'POST',
        headers: { ...supaHeaders, Prefer: 'return=representation' },
        body: JSON.stringify(donnees),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const rows = await resp.json();
      return res.status(200).json({ success: true, id: rows[0].id });
    } catch (err) {
      console.error('estimateur-btp-devis POST error:', err.message);
      return res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  }

  if (req.method === 'DELETE') {
    const email = String(req.query?.email || '').trim().toLowerCase();
    const id = String(req.query?.id || '');
    if (!emailValide(email) || !id) {
      return res.status(400).json({ success: false, error: 'Paramètres manquants' });
    }
    try {
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/estimateur_btp_devis?id=eq.${encodeURIComponent(id)}&email=eq.${encodeURIComponent(email)}`,
        { method: 'DELETE', headers: { ...supaHeaders, Prefer: 'return=minimal' } }
      );
      if (!resp.ok) throw new Error(await resp.text());
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('estimateur-btp-devis DELETE error:', err.message);
      return res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  }

  return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
}
