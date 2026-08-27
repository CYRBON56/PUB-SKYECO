// api/prospects-send-sms.js
// Envoie un SMS de prospection au nom du site (draft_id) demandé, avec le
// lien de tracking vers l'estimation du mini-site.
//
// Requête attendue : POST  Body: { draft_id, ids: [...] }
// Variables d'environnement requises : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import twilio from "twilio";

const BASE_URL = "https://pub-skyeco-23ue.vercel.app";
const TAILLE_LOT = 100;

function decouperEnLots(t, taille = TAILLE_LOT) { const l = []; for (let i=0;i<t.length;i+=taille) l.push(t.slice(i,i+taille)); return l; }
function genererToken() { const b = Array.from({length:6}, () => Math.floor(Math.random()*256)); return Buffer.from(b).toString("base64url").slice(0,8); }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Méthode non autorisée." });

  const { draft_id, ids } = req.body || {};
  if (!draft_id) return res.status(400).json({ success: false, error: "Identifiant de site manquant." });
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, error: "Aucun prospect sélectionné." });

  const supaHeaders = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };

  try {
    const draftResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draft_id}&select=id,entreprise`, { headers: supaHeaders });
    const draftRows = draftResp.ok ? await draftResp.json() : [];
    const draft = draftRows[0];
    if (!draft) return res.status(404).json({ success: false, error: "Site introuvable." });

    let tousLesProspects = [];
    for (const lot of decouperEnLots(ids)) {
      const idsFilter = lot.map((id) => `"${id}"`).join(",");
      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?id=in.(${idsFilter})&draft_id=eq.${draft_id}&select=id,nom,telephone_e164,opt_out,clic_token`, { headers: supaHeaders });
      if (!resp.ok) throw new Error("Lecture Supabase impossible : " + (await resp.text()));
      tousLesProspects = tousLesProspects.concat(await resp.json());
    }

    const sansTel = tousLesProspects.filter((p) => !p.telephone_e164).map((p) => p.id);
    const prospects = tousLesProspects.filter((p) => p.telephone_e164 && !p.opt_out);
    const ignoresOptOut = tousLesProspects.filter((p) => p.telephone_e164 && p.opt_out).map((p) => p.id);

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const results = [];

    for (const p of prospects) {
      if (!p.clic_token) {
        p.clic_token = genererToken();
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?id=eq.${encodeURIComponent(p.id)}`, {
          method: "PATCH", headers: { ...supaHeaders, Prefer: "return=minimal" }, body: JSON.stringify({ clic_token: p.clic_token }),
        });
      }
      const lien = `${BASE_URL}/l?p=${p.clic_token}`;
      const message = `${draft.entreprise} : votre estimation gratuite en 2 min → ${lien}\nRép. STOP pour ne plus recevoir de SMS.`;
      try {
        await client.messages.create({ body: message, from: process.env.TWILIO_FROM_NUMBER, to: p.telephone_e164 });
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_vitrine?id=eq.${encodeURIComponent(p.id)}`, {
          method: "PATCH", headers: { ...supaHeaders, Prefer: "return=minimal" }, body: JSON.stringify({ sms_envoye: true, date_envoi: new Date().toISOString() }),
        });
        results.push({ id: p.id, success: true });
      } catch (err) {
        console.error("SMS échoué pour", p.telephone_e164, err.message);
        results.push({ id: p.id, success: false, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      envoyes: results.filter((r) => r.success).length,
      echoues: results.filter((r) => !r.success).length,
      ignoresOptOut: ignoresOptOut.length,
      ignoresSansTel: sansTel.length,
      details: results,
    });
  } catch (err) {
    console.error("prospects-send-sms error:", err);
    return res.status(500).json({ success: false, error: "Envoi impossible : " + err.message });
  }
}
