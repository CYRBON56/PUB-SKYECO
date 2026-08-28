// /api/verifier-inactivite.js
// Tâche planifiée (Vercel Cron, quotidienne) qui applique la clause CGV :
// un site dont le paiement échoue depuis plus de 2 mois consécutifs est
// définitivement désactivé.
//
// Configuration requise dans vercel.json :
//   { "crons": [{ "path": "/api/verifier-inactivite", "schedule": "0 6 * * *" }] }
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   CRON_SECRET (protège l'endpoint contre les appels non autorisés)

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  const deuxMoisAvant = new Date();
  deuxMoisAvant.setMonth(deuxMoisAvant.getMonth() - 2);

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?subscription_status=eq.paiement_echoue&echec_paiement_depuis_le=lt.${deuxMoisAvant.toISOString()}&status=neq.desactive&select=id,entreprise`,
      { headers: supaHeaders }
    );
    if (!resp.ok) throw new Error('Impossible de lire les sites concernés.');
    const sitesAFermer = await resp.json();

    for (const site of sitesAFermer) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${site.id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'desactive', subscription_status: 'fermee_impaye' }),
      });
    }

    return res.status(200).json({
      success: true,
      sitesFermes: sitesAFermer.length,
      details: sitesAFermer.map(s => s.entreprise),
    });
  } catch (err) {
    console.error('Erreur verifier-inactivite :', err);
    return res.status(500).json({ error: err.message });
  }
}
