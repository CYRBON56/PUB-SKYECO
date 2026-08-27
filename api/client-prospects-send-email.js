// api/client-prospects-send-email.js
// Envoie un email de prospection pour le compte de L'ENTREPRISE CONNECTÉE,
// vers ses propres prospects sélectionnés. L'email est envoyé "au nom de"
// l'entreprise cliente (adresse d'expédition partagée Skyeco Pro, avec le
// nom de l'entreprise en display-name et reply-to sur son adresse réelle)
// — tant que le client n'a pas vérifié son propre domaine dans Resend.
//
// Requête attendue : POST, Headers: Authorization: Bearer <token Supabase Auth>
//   Body: { ids: ["uuid1", "uuid2", ...] }

import { authentifierEntreprise } from "./_lib/auth-entreprise.js";

const BASE_URL = "https://skyeco-pro.vercel.app";
const TAILLE_LOT = 100;

function decouperEnLots(tableau, taille = TAILLE_LOT) {
  const lots = [];
  for (let i = 0; i < tableau.length; i += taille) lots.push(tableau.slice(i, i + taille));
  return lots;
}

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function genererToken() {
  const bytes = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
  return Buffer.from(bytes).toString("base64url").slice(0, 8);
}

function emailHtml(entreprise, nom, token) {
  const lienVitrine = entreprise.slug ? `${BASE_URL}/f/${entreprise.slug}` : `${BASE_URL}/l?p=${token}`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f4f4">
    <tr><td align="center" style="padding:24px 16px;">
      <table width="560" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:560px;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#14312a;padding:24px 32px;">
          <span style="font-family:Arial,sans-serif;font-size:17px;font-weight:800;color:#ffffff;">${escapeHtml(entreprise.nom)}</span>
        </td></tr>
        <tr><td style="padding:32px;font-family:Arial,sans-serif;">
          <p style="font-size:15px;line-height:23px;color:#1a1a1a;margin:0 0 16px 0;">
            Bonjour${nom ? " " + escapeHtml(nom) : ""},
          </p>
          <p style="font-size:15px;line-height:23px;color:#1a1a1a;margin:0 0 20px 0;">
            ${escapeHtml(entreprise.nom)} vous propose une estimation rapide et sans engagement pour votre projet.
          </p>
          <table cellpadding="0" cellspacing="0"><tr><td bgcolor="#1e6f4c" style="border-radius:6px;">
            <a href="${lienVitrine}" style="display:block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Voir mon estimation</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #eee;font-family:Arial,sans-serif;">
          <p style="font-size:11px;color:#888;margin:0;">
            Vous recevez cet email de la part de ${escapeHtml(entreprise.nom)}.
            <a href="${BASE_URL}/d?p=${token}" style="color:#888;">Se désabonner</a>
          </p>
        </td></tr>
      </table>
      <img src="${BASE_URL}/o?p=${token}" width="1" height="1" alt="" style="display:block;border:0;" />
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

class QuotaJournalierAtteint extends Error {}

async function envoyerViaResend(to, entreprise, nom, token) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${entreprise.nom} via Skyeco Pro <contact@ecoskybyrms.fr>`,
      reply_to: entreprise.email || undefined,
      to: [to],
      subject: `${entreprise.nom} — Votre estimation gratuite`,
      html: emailHtml(entreprise, nom, token),
      headers: {
        "List-Unsubscribe": `<${BASE_URL}/d?p=${token}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function envoyerAvecRetry(to, entreprise, nom, token, tentativesMax = 4) {
  for (let tentative = 1; tentative <= tentativesMax; tentative++) {
    try {
      return await envoyerViaResend(to, entreprise, nom, token);
    } catch (err) {
      if (/daily_quota_exceeded/i.test(err.message || "")) throw new QuotaJournalierAtteint(err.message);
      const estRateLimit = err.status === 429 || /rate.?limit/i.test(err.message || "");
      if (estRateLimit && tentative < tentativesMax) {
        await dormir(800 * tentative);
        continue;
      }
      throw err;
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Méthode non autorisée." });
  }

  const { entreprise, error, status } = await authentifierEntreprise(req);
  if (error) return res.status(status).json({ success: false, error });

  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: "Aucun prospect sélectionné." });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    // Lecture par lots, filtrée à la fois par IDs ET par entreprise_id —
    // double sécurité pour qu'un client ne puisse jamais toucher aux
    // prospects d'un autre, même en manipulant les IDs envoyés au serveur.
    let tousLesProspects = [];
    for (const lot of decouperEnLots(ids)) {
      const idsFilter = lot.map((id) => `"${id}"`).join(",");
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/prospects_clients?id=in.(${idsFilter})&entreprise_id=eq.${entreprise.id}&select=id,nom,email,opt_out,clic_token`,
        { headers: supaHeaders }
      );
      if (!resp.ok) {
        const detail = await resp.text();
        throw new Error("Lecture Supabase impossible : " + detail);
      }
      tousLesProspects = tousLesProspects.concat(await resp.json());
    }

    const sansEmail = tousLesProspects.filter((p) => !p.email).map((p) => p.id);
    const prospects = tousLesProspects.filter((p) => p.email && !p.opt_out);
    const ignoresOptOut = tousLesProspects.filter((p) => p.email && p.opt_out).map((p) => p.id);

    for (const p of prospects) {
      if (!p.clic_token) {
        p.clic_token = genererToken();
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_clients?id=eq.${encodeURIComponent(p.id)}`, {
          method: "PATCH",
          headers: { ...supaHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ clic_token: p.clic_token }),
        });
      }
    }

    const results = [];
    let quotaAtteint = false;
    for (const p of prospects) {
      if (quotaAtteint) {
        results.push({ id: p.id, success: false, error: "Non tenté : quota journalier atteint." });
        continue;
      }
      try {
        await envoyerAvecRetry(p.email, entreprise, p.nom, p.clic_token);
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_clients?id=eq.${encodeURIComponent(p.id)}`, {
          method: "PATCH",
          headers: { ...supaHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ email_envoye: true, date_envoi_email: new Date().toISOString() }),
        });
        results.push({ id: p.id, success: true });
      } catch (err) {
        if (err instanceof QuotaJournalierAtteint) {
          quotaAtteint = true;
          results.push({ id: p.id, success: false, error: "Quota journalier atteint." });
          continue;
        }
        console.error("client email échoué pour", p.email, err.message);
        results.push({ id: p.id, success: false, error: err.message });
      }
      await dormir(350);
    }

    return res.status(200).json({
      success: true,
      envoyes: results.filter((r) => r.success).length,
      echoues: results.filter((r) => !r.success).length,
      ignoresOptOut: ignoresOptOut.length,
      ignoresSansEmail: sansEmail.length,
      quotaAtteint,
      details: results,
    });
  } catch (err) {
    console.error("client-prospects-send-email error:", err);
    return res.status(500).json({ success: false, error: "Envoi impossible : " + err.message });
  }
}
