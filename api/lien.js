// api/lien.js
// Lien de tracking court inséré dans les SMS/emails de prospection, servi
// sur /l?p=<clic_token>[&to=<url encodée>] (voir vercel.json).
// - Jeton trouvé dans prospects_vitrine (un artisan qui prospecte SES
//   clients) : redirige vers apercu.html du site concerné, comme avant.
// - Jeton trouvé dans prospects_paysagiste (Skyeco Pro qui prospecte des
//   artisans pour l'abonnement — 04/09) : redirige vers "to" si fourni
//   (ex: la vidéo de démo), sinon vers la page d'inscription Skyeco Pro.

const DESTINATION_PAR_DEFAUT = "https://app.skyeco.fr/index.html";
const DESTINATION_PROSPECTION_ARTISANS = "https://www.skyeco.fr/skyeco-pro-formulaire-creation.html";

export default async function handler(req, res) {
  const { p, to } = req.query || {};
  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  let destination = DESTINATION_PAR_DEFAUT;

  if (p) {
    try {
      const lecture = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?clic_token=eq.${encodeURIComponent(p)}&select=id,draft_id,nb_clics`,
        { headers: supaHeaders }
      );
      const rows = lecture.ok ? await lecture.json() : [];
      const prospect = rows && rows[0];

      if (prospect) {
        destination = `https://app.skyeco.fr/apercu.html?id=${prospect.draft_id}`;
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?id=eq.${encodeURIComponent(prospect.id)}`, {
          method: "PATCH",
          headers: { ...supaHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ lien_clique: true, clic_date: new Date().toISOString(), nb_clics: (prospect.nb_clics || 0) + 1 }),
        });
      } else {
        const lecturePaysagiste = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?clic_token=eq.${encodeURIComponent(p)}&select=id,nb_clics`,
          { headers: supaHeaders }
        );
        const rowsPaysagiste = lecturePaysagiste.ok ? await lecturePaysagiste.json() : [];
        const prospectPaysagiste = rowsPaysagiste && rowsPaysagiste[0];
        if (prospectPaysagiste) {
          destination = to ? decodeURIComponent(to) : DESTINATION_PROSPECTION_ARTISANS;
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?id=eq.${encodeURIComponent(prospectPaysagiste.id)}`, {
            method: "PATCH",
            headers: { ...supaHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ lien_clique: true, clicked_at: new Date().toISOString(), nb_clics: (prospectPaysagiste.nb_clics || 0) + 1 }),
          });
        }
      }
    } catch (err) {
      console.error("lien tracking error:", err);
    }
  }

  res.writeHead(302, { Location: destination });
  return res.end();
}
