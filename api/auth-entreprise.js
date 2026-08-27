// api/_lib/auth-entreprise.js
// Vérifie le token Supabase Auth envoyé par le dashboard client et retourne
// l'entreprise correspondante. Utilisé par toutes les routes
// api/client-prospects-*.js pour s'assurer qu'une entreprise ne peut jamais
// voir ou modifier les prospects d'une autre.
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export async function authentifierEntreprise(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return { error: "Non authentifié.", status: 401 };
  }

  // 1. Vérifie le token auprès de Supabase Auth et récupère l'utilisateur.
  const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userResp.ok) {
    return { error: "Session invalide, merci de vous reconnecter.", status: 401 };
  }
  const user = await userResp.json();
  if (!user || !user.id) {
    return { error: "Session invalide, merci de vous reconnecter.", status: 401 };
  }

  // 2. Récupère l'entreprise possédée par cet utilisateur.
  const entrepriseResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/entreprises?select=id,nom,email,slug,abonnement_actif&owner_user_id=eq.${encodeURIComponent(user.id)}`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!entrepriseResp.ok) {
    return { error: "Impossible de vérifier votre entreprise.", status: 500 };
  }
  const rows = await entrepriseResp.json();
  const entreprise = rows && rows[0];
  if (!entreprise) {
    return { error: "Aucune entreprise associée à ce compte.", status: 403 };
  }
  if (!entreprise.abonnement_actif) {
    return { error: "Votre abonnement n'est pas actif.", status: 403 };
  }

  return { entreprise };
}
