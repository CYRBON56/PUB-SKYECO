// api/agent-leads.js
// 🤖 AGENT LEADS — RMS EcoSky (RESINE MARBRE SOL)
//
// Analyse chaque demande client avec Claude : niveau (chaud / tiède / froid),
// score sur 100, résumé, points à vérifier, action recommandée, et propose un
// SMS + un email de réponse personnalisés. RIEN n'est envoyé au client :
// l'agent prépare, Cyrille valide.
//
// Deux modes de déclenchement :
//  1. Instantané : appelé par submit-estimation.js avec ?lead_id=... juste
//     après une nouvelle estimation → SMS d'analyse à Cyrille.
//  2. Quotidien (cron vercel.json, 8h UTC) : rattrape tous les leads des
//     14 derniers jours jamais analysés (formulaires abandonnés, leads
//     Facebook via Make, chat) → un SMS récap + un email complet.
//
// Sécurité : exige l'en-tête Authorization: Bearer CRON_SECRET
// (Vercel l'ajoute automatiquement aux appels cron).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const TWILIO_TO_NUMBER = process.env.TWILIO_TO_NUMBER;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "estimation@ecoskybyrms.fr";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "infos@ecosky.fr";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_LEADS_PAR_PASSAGE = 15;
const JOURS_RATTRAPAGE = 14;
const DASHBOARD_URL = "https://salesflow-ecosky.vercel.app/sms-recus.html";

const CONTEXTE_ENTREPRISE = `
Tu es l'assistant commercial de RMS EcoSky (raison sociale RESINE MARBRE SOL, SASU,
23 route de Corn er Hoët 56400 Brech, SIRET 939 997 870 00018), dirigée par Cyrille Bon.
Activité principale : revêtement de sol résine EPDM EcoSky'Gum (terrasses, plages de
piscine, allées) et granulat lié quartz/granit/marbre pour zones carrossables. Activités
annexes : assainissement non collectif, clôtures, portails, enrobés.

Grille de prix indicative :
- Piéton (EPDM) : 115 € HT/m² sur dalle béton, carrelage déposé par le client ou pavé.
  Dalle à reprendre = supplément après visite. Carrelage à déposer par RMS ou terrain nu = non chiffrable sans visite.
- Carrossable (jamais d'EPDM) : 180 € HT/m² sur terre nue (terrassement compris),
  à partir de 150 € HT/m² si terrain préparé, bordure 45 € HT/ml, couleur hors beige/jaune +50 € HT/m².
- Surface minimum 10 m² (en dessous, RMS n'intervient pas).
- TVA 10 % si logement de plus de 2 ans, 20 % sinon.
- Remise volume sur TTC : 5 % sous 5 000 €, 10 % de 5 000 à 10 000 €, 15 % au-delà.
Zone d'intervention : départements 56, 29, 22, 35 ; 44 en secteur élargi (plus-value déplacement possible).
Hors zone = refus poli.

Ton de voix : professionnel, chaleureux, direct, vouvoiement. On signe "L'équipe RMS EcoSky".
Objectif commercial : obtenir un échange téléphonique ou une visite technique.
`;

const INSTRUCTIONS = `
Analyse le lead ci-dessous et réponds UNIQUEMENT avec un objet JSON valide, sans texte
autour, sans balises markdown, avec exactement ces clés :
{
  "niveau": "chaud" | "tiede" | "froid" | "hors_cible",
  "score": entier de 0 à 100,
  "resume": "1 à 2 phrases : qui, quoi, où, combien",
  "points_attention": ["liste courte de points à vérifier ou risques"],
  "action_recommandee": "l'action concrète que Cyrille doit faire, avec un délai",
  "sms_propose": "SMS de réponse au client, 300 caractères maximum",
  "email_objet": "objet de l'email proposé",
  "email_corps": "corps de l'email proposé en texte simple, sauts de ligne avec \\n"
}
Critères : chaud = projet clair, dans la zone, surface ≥ 10 m², délai court ou rendez-vous pris.
Froid = infos très incomplètes, formulaire abandonné, délai lointain. Hors cible = hors zone,
moins de 10 m², ou demande sans rapport. Si le formulaire n'est pas terminé, le SMS doit
inviter à le finir ou proposer un appel. Ne promets jamais un prix ferme : tout prix reste
indicatif et à confirmer par un technicien. N'invente aucune information absente du lead.
`;

// ---------- Utilitaires ----------

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !to) return false;
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }).toString(),
      }
    );
    if (!res.ok) console.error("Agent leads — Twilio:", await res.text());
    return res.ok;
  } catch (e) {
    console.error("Agent leads — sendSms:", e.message);
    return false;
  }
}

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: OWNER_EMAIL, subject, html }),
    });
    if (!res.ok) console.error("Agent leads — Resend:", await res.text());
    return res.ok;
  } catch (e) {
    console.error("Agent leads — sendEmail:", e.message);
    return false;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Ne garde que les champs utiles (et non vides) du lead pour l'analyse.
function nettoyerLead(lead) {
  const exclus = ["id", "session_id", "agent_analyse", "agent_score", "agent_niveau", "agent_traite_at",
    "rdv_cancel_url", "rdv_reschedule_url", "estimation_pdf_url"];
  const out = {};
  for (const [k, v] of Object.entries(lead)) {
    if (exclus.includes(k) || v === null || v === "" || (typeof v === "object" && !Object.keys(v).length)) continue;
    out[k] = v;
  }
  return out;
}

// ---------- Cœur de l'agent ----------

async function analyserLead(lead) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: CONTEXTE_ENTREPRISE,
      messages: [
        {
          role: "user",
          content: `${INSTRUCTIONS}\n\nDate du jour : ${new Date().toLocaleDateString("fr-FR")}\n\nLEAD :\n${JSON.stringify(nettoyerLead(lead), null, 2)}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const texte = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  const debut = texte.indexOf("{");
  const fin = texte.lastIndexOf("}");
  const analyse = JSON.parse(texte.slice(debut, fin + 1));
  analyse.score = Math.max(0, Math.min(100, parseInt(analyse.score, 10) || 0));
  return analyse;
}

const EMOJI = { chaud: "🔥", tiede: "🌤️", froid: "❄️", hors_cible: "⛔" };

function blocEmail(lead, a) {
  const nom = escapeHtml(`${lead.prenom || ""} ${lead.nom || ""}`.trim() || "Sans nom");
  const points = (a.points_attention || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  return `
  <div style="border:1px solid #ddd;border-radius:10px;padding:16px;margin:0 0 18px;font-family:Arial,sans-serif;">
    <h3 style="margin:0 0 6px;">${EMOJI[a.niveau] || ""} ${nom} — ${escapeHtml(a.niveau)} ${a.score}/100</h3>
    <p style="margin:0 0 8px;color:#555;">${escapeHtml(lead.telephone || "")} ${lead.email ? "· " + escapeHtml(lead.email) : ""} ${lead.code_postal ? "· " + escapeHtml(lead.code_postal) : ""}</p>
    <p><strong>Résumé :</strong> ${escapeHtml(a.resume)}</p>
    ${points ? `<p><strong>À vérifier :</strong></p><ul>${points}</ul>` : ""}
    <p><strong>👉 Action :</strong> ${escapeHtml(a.action_recommandee)}</p>
    <p><strong>SMS proposé :</strong></p>
    <div style="background:#f4f4f4;padding:10px;border-radius:6px;">${escapeHtml(a.sms_propose)}</div>
    <p><strong>Email proposé — ${escapeHtml(a.email_objet)} :</strong></p>
    <div style="background:#f4f4f4;padding:10px;border-radius:6px;white-space:pre-wrap;">${escapeHtml(a.email_corps)}</div>
  </div>`;
}

// ---------- Handler ----------

export default async function handler(req, res) {
  if (!CRON_SECRET || req.headers["authorization"] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Variables d'environnement manquantes" });
  }

  const leadId = req.query?.lead_id;
  const modeInstantane = Boolean(leadId);

  try {
    let leads;
    if (modeInstantane) {
      leads = await supabaseRequest(`leads?id=eq.${encodeURIComponent(leadId)}&select=*`);
    } else {
      const depuis = new Date(Date.now() - JOURS_RATTRAPAGE * 86400000).toISOString();
      leads = await supabaseRequest(
        `leads?select=*&agent_traite_at=is.null&created_at=gte.${depuis}&order=created_at.asc&limit=${MAX_LEADS_PAR_PASSAGE}`
      );
    }

    const resultats = [];
    for (const lead of leads || []) {
      try {
        const a = await analyserLead(lead);
        await supabaseRequest(`leads?id=eq.${lead.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            agent_niveau: a.niveau,
            agent_score: a.score,
            agent_analyse: a,
            agent_traite_at: new Date().toISOString(),
          }),
        });
        resultats.push({ lead, a });
      } catch (e) {
        console.error(`Agent leads — lead ${lead.id}:`, e.message);
      }
    }

    if (resultats.length) {
      resultats.sort((x, y) => y.a.score - x.a.score);

      if (modeInstantane) {
        const { lead, a } = resultats[0];
        await sendSms(
          TWILIO_TO_NUMBER,
          `🤖 Analyse ${EMOJI[a.niveau] || ""} ${a.niveau.toUpperCase()} ${a.score}/100\n` +
            `${lead.prenom || ""} ${lead.nom || ""}\n${a.resume}\n👉 ${a.action_recommandee}`
        );
      } else {
        const lignes = resultats
          .slice(0, 5)
          .map(({ lead, a }) => `${EMOJI[a.niveau] || ""} ${lead.prenom || lead.nom || "?"} ${a.score}/100`)
          .join("\n");
        await sendSms(
          TWILIO_TO_NUMBER,
          `🤖 Récap leads du matin (${resultats.length})\n${lignes}\nDétail + messages prêts dans ton email.`
        );
      }

      await sendEmail(
        modeInstantane
          ? `🤖 Analyse lead — ${resultats[0].lead.prenom || ""} ${resultats[0].lead.nom || ""} (${resultats[0].a.score}/100)`
          : `🤖 Récap agent leads — ${resultats.length} demande(s) analysée(s)`,
        `<div style="font-family:Arial,sans-serif;max-width:680px;">
          <p>Messages proposés à relire avant envoi. <a href="${DASHBOARD_URL}">Ouvrir le tableau de bord</a></p>
          ${resultats.map(({ lead, a }) => blocEmail(lead, a)).join("")}
        </div>`
      );
    }

    return res.status(200).json({ success: true, analyses: resultats.length });
  } catch (err) {
    console.error("Agent leads error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
