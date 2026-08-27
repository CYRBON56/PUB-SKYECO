// api/desabonnement.js
function pageConfirmation({ succes, nom }) {
  const titre = succes ? "Vous êtes désabonné" : "Lien invalide";
  const message = succes ? `Vous ne recevrez plus aucune communication${nom ? " de la part de " + nom : ""}.` : "Ce lien de désabonnement n'est plus valide ou a déjà été utilisé.";
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titre}</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#14312a;color:#fff;}
.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}
.card{max-width:420px;text-align:center;}
.badge{display:inline-block;width:56px;height:56px;border-radius:50%;background:#1e6f4c;line-height:56px;font-size:26px;margin-bottom:20px;}
h1{font-size:1.4rem;margin:0 0 12px;} p{color:#cfe0d8;font-size:0.95rem;line-height:1.5;margin:0;}</style></head>
<body><div class="wrap"><div class="card"><div class="badge">${succes?"&#10003;":"&#33;"}</div><h1>${titre}</h1><p>${message}</p></div></div></body></html>`;
}

export default async function handler(req, res) {
  const { p } = req.query || {};
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!p) return res.status(200).send(pageConfirmation({ succes: false }));

  try {
    const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
    const lecture = await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?clic_token=eq.${encodeURIComponent(p)}&select=id,nom`, { headers });
    const rows = lecture.ok ? await lecture.json() : [];
    const prospect = rows && rows[0];
    if (!prospect) return res.status(200).send(pageConfirmation({ succes: false }));

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?id=eq.${encodeURIComponent(prospect.id)}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ opt_out: true, opt_out_date: new Date().toISOString() }),
    });
    return res.status(200).send(pageConfirmation({ succes: true, nom: prospect.nom }));
  } catch (err) {
    console.error("desabonnement error:", err);
    return res.status(200).send(pageConfirmation({ succes: false }));
  }
}
