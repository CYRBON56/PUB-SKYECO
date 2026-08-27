// api/lien.js
// Lien de tracking court — cherche le token d'abord dans prospects_sms
// (outil interne RMS), puis dans prospects_clients (prospects de chaque
// entreprise abonnée à Skyeco Pro) si non trouvé.

const TARIFS_URL = "https://skyeco-pro.vercel.app/tarifs.html";
const EXEMPLE_URL = "https://salesflow-ecosky.vercel.app/estimation.html";

async function chercherEtIncrementer(table, token, colonneCompteur) {
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
  const lecture = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/${table}?clic_token=eq.${encodeURIComponent(token)}&select=id,${colonneCompteur}`,
    { headers }
  );
  const rows = lecture.ok ? await lecture.json() : [];
  const prospect = rows && rows[0];
  if (!prospect) return false;

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(prospect.id)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      lien_clique: true,
      clic_date: new Date().toISOString(),
      nb_clics: (prospect[colonneCompteur] || 0) + 1,
    }),
  });
  return true;
}

export default async function handler(req, res) {
  const { p, dest } = req.query || {};
  const destination = dest === "exemple" ? EXEMPLE_URL : TARIFS_URL;

  if (!p) {
    res.writeHead(302, { Location: destination });
    return res.end();
  }

  try {
    const trouveInterne = await chercherEtIncrementer("prospects_sms", p, "nb_clics");
    if (!trouveInterne) {
      await chercherEtIncrementer("prospects_clients", p, "nb_clics");
    }
  } catch (err) {
    console.error("lien tracking error:", err);
  }

  res.writeHead(302, { Location: destination });
  return res.end();
}
