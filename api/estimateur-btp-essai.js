// /api/estimateur-btp-essai.js
// Démarre (ou renvoie, si déjà démarré) l'essai gratuit de 5 jours de
// l'Estimateur BTP (public/estimateur-btp.html), à partir d'un simple email
// — pas de mot de passe, pas de carte bancaire, dans le même esprit "essai
// sans friction" que le reste de Skyeco Pro.
//
// Cas particulier important : toute personne ayant déjà acheté le "Kit Pro
// Artisan BTP" (table kit_pro_commandes) reçoit un accès illimité et
// automatique — ce produit à 29€ incluait déjà un lien vers l'Estimateur BTP
// en bonus, sans restriction, AVANT que celui-ci ne devienne un produit payant
// séparé à 29,90€ HT/mois (24-25/09/2026). On ne casse pas cette promesse
// déjà faite aux acheteurs existants.
//
// Idempotent : un email qui a déjà un essai en cours (ou un abonnement actif)
// se voit renvoyer son état existant, jamais réinitialisé.
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const DUREE_ESSAI_JOURS = 5;

function emailValide(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function etatPourReponse(row) {
  return {
    email: row.email,
    essai_fin: row.essai_fin,
    abonnement_actif: row.abonnement_actif,
    source: row.source,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!emailValide(email)) {
    return res.status(400).json({ success: false, error: 'Email invalide' });
  }

  try {
    // 1) Déjà un accès enregistré (essai en cours, abonné, ou déjà repéré
    //    comme acheteur Kit Pro) ? On ne réinitialise jamais.
    const existants = await supabaseRequest(
      `estimateur_btp_acces?email=eq.${encodeURIComponent(email)}&select=*&limit=1`
    );
    if (Array.isArray(existants) && existants.length > 0) {
      return res.status(200).json({ success: true, ...etatPourReponse(existants[0]), dejaDemarre: true });
    }

    // 2) Pas encore d'accès : a-t-il déjà acheté le Kit Pro Artisan BTP ?
    const achatsKitPro = await supabaseRequest(
      `kit_pro_commandes?email=eq.${encodeURIComponent(email)}&statut=eq.paye&select=id&limit=1`
    );
    const dejaClientKitPro = Array.isArray(achatsKitPro) && achatsKitPro.length > 0;

    const maintenant = new Date();
    const nouvelleLigne = dejaClientKitPro
      ? {
          email,
          abonnement_actif: true,
          source: 'kit_pro',
          essai_debut: null,
          essai_fin: null,
        }
      : {
          email,
          abonnement_actif: false,
          source: 'essai',
          essai_debut: maintenant.toISOString(),
          essai_fin: new Date(maintenant.getTime() + DUREE_ESSAI_JOURS * 24 * 60 * 60 * 1000).toISOString(),
        };

    const inserted = await supabaseRequest('estimateur_btp_acces', {
      method: 'POST',
      body: JSON.stringify(nouvelleLigne),
    });

    return res.status(200).json({ success: true, ...etatPourReponse(inserted[0]), dejaDemarre: false });
  } catch (err) {
    console.error('estimateur-btp-essai error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur, réessayez.' });
  }
}
