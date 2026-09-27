// api/agent-pub.js
// 📊 AGENT PUB — RMS EcoSky (RESINE MARBRE SOL)
//
// Chaque lundi matin (cron vercel.json) :
//  1. récupère les chiffres Meta Ads + Google Ads des 14 derniers jours via
//     l'API Windsor.ai (une seule clé pour les deux plateformes) ;
//  2. compare la semaine écoulée à la précédente, campagne par campagne ;
//  3. croise avec les VRAIS leads reçus dans Supabase (par source) ;
//  4. relit le rapport de la semaine dernière pour vérifier le suivi ;
//  5. demande à Claude une synthèse + 3 actions concrètes ;
//  6. t'envoie un SMS court + un email complet, et archive le rapport.
//
// Test manuel dans le navigateur :
//   https://salesflow-ecosky.vercel.app/api/agent-pub?secret=TON_CRON_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const TWILIO_TO_NUMBER = process.env.TWILIO_TO_NUMBER;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "estimation@ecoskybyrms.fr";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "infos@ecosky.fr";

const MODEL = "claude-sonnet-5";

const SOURCES = {
  meta: {
    connector: "facebook",
    fields: ["date", "campaign", "spend", "impressions", "link_clicks", "cpc", "actions_lead", "actions_landing_page_view", "frequency"],
  },
  google: {
    connector: "google_ads",
    fields: ["date", "campaign", "spend", "impressions", "clicks", "cpc", "conversions"],
  },
};

// ---------- Utilitaires ----------

const jourISO = (d) => d.toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const arrondi = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;

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
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }).toString(),
    });
    if (!res.ok) console.error("Agent pub — Twilio:", await res.text());
    return res.ok;
  } catch (e) {
    console.error("Agent pub — sendSms:", e.message);
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
    if (!res.ok) console.error("Agent pub — Resend:", await res.text());
    return res.ok;
  } catch (e) {
    console.error("Agent pub — sendEmail:", e.message);
    return false;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- Collecte des données ----------

async function windsor(connector, fields, dateFrom, dateTo) {
  const url =
    `https://connectors.windsor.ai/${connector}?api_key=${encodeURIComponent(WINDSOR_API_KEY)}` +
    `&date_from=${dateFrom}&date_to=${dateTo}&fields=${fields.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Windsor ${connector} ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return Array.isArray(json) ? json : json.data || [];
}

// Regroupe les lignes quotidiennes par campagne, en séparant semaine en cours / précédente.
function agreger(lignes, plateforme, debutSemaine) {
  const parCampagne = {};
  for (const l of lignes) {
    const semaine = l.date >= debutSemaine ? "cette_semaine" : "semaine_precedente";
    const nom = l.campaign || "(sans nom)";
    parCampagne[nom] ??= {
      cette_semaine: { depense: 0, impressions: 0, clics: 0, leads_ou_conversions: 0, vues_page: 0 },
      semaine_precedente: { depense: 0, impressions: 0, clics: 0, leads_ou_conversions: 0, vues_page: 0 },
    };
    const s = parCampagne[nom][semaine];
    s.depense += num(l.spend);
    s.impressions += num(l.impressions);
    s.clics += num(plateforme === "meta" ? l.link_clicks : l.clicks);
    s.leads_ou_conversions += num(plateforme === "meta" ? l.actions_lead : l.conversions);
    s.vues_page += num(l.actions_landing_page_view);
  }
  for (const c of Object.values(parCampagne)) {
    for (const s of [c.cette_semaine, c.semaine_precedente]) {
      s.depense = arrondi(s.depense);
      s.cpc = s.clics ? arrondi(s.depense / s.clics) : null;
      s.ctr_pct = s.impressions ? arrondi((s.clics / s.impressions) * 100) : null;
      s.cout_par_lead = s.leads_ou_conversions ? arrondi(s.depense / s.leads_ou_conversions) : null;
    }
  }
  return parCampagne;
}

async function leadsSupabase(dateFrom, debutSemaine) {
  const leads = await supabaseRequest(
    `leads?select=source,created_at,formulaire_complete,agent_niveau&created_at=gte.${dateFrom}T00:00:00`
  );
  const out = { cette_semaine: {}, semaine_precedente: {} };
  for (const l of leads || []) {
    const semaine = l.created_at.slice(0, 10) >= debutSemaine ? "cette_semaine" : "semaine_precedente";
    const src = l.source || "inconnue";
    out[semaine][src] ??= { total: 0, formulaires_complets: 0, chauds: 0 };
    out[semaine][src].total++;
    if (l.formulaire_complete) out[semaine][src].formulaires_complets++;
    if (l.agent_niveau === "chaud") out[semaine][src].chauds++;
  }
  return out;
}

// ---------- Analyse Claude ----------

const CONTEXTE = `
Tu es le responsable acquisition de RMS EcoSky (RESINE MARBRE SOL, Brech, Morbihan) :
revêtement de sol résine EPDM EcoSky'Gum (terrasses, plages de piscine) et granulat lié
pour zones carrossables, zone d'intervention 56/29/22/35 (+44 en secteur élargi).
Panier moyen chantier : plusieurs milliers d'euros, donc un coût par lead de 20 à 60 €
reste rentable si le lead est qualifié. Budgets modestes (environ 10 €/jour par campagne).
Tunnel : pub → formulaire d'estimation salesflow-ecosky.vercel.app/estimation.html
(ou formulaire instantané Meta) → lead dans Supabase → appel technicien.
Les "leads Supabase" sont la vérité terrain ; les conversions déclarées par les plateformes
peuvent être mal suivies (0 conversion Google alors que des leads arrivent = tracking à revoir).
Le dirigeant n'est pas un spécialiste pub : actions concrètes, chiffrées, faisables en 15 min.
`;

const INSTRUCTIONS = `
À partir des données ci-dessous, réponds UNIQUEMENT avec un objet JSON valide, sans texte autour :
{
  "synthese": "3 phrases maximum : ce qui marche, ce qui ne marche pas, verdict de la semaine",
  "depense_totale": nombre (euros, semaine écoulée, toutes plateformes),
  "leads_reels": nombre (leads Supabase de la semaine écoulée),
  "cout_par_lead_reel": nombre ou null (dépense totale / leads réels),
  "alertes": ["problèmes urgents : argent gaspillé, tracking cassé, campagne à 0 résultat..."],
  "suivi_semaine_derniere": "les actions recommandées la semaine dernière semblent-elles avoir eu un effet ? (null si pas de rapport précédent)",
  "actions": [
    { "titre": "action courte (max 60 caractères)", "pourquoi": "chiffre à l'appui", "comment": "où cliquer / quoi changer, étape par étape, en texte" }
  ]
}
Exactement 3 actions, classées par impact. Si une plateforme ne renvoie aucune donnée,
signale-le dans les alertes (compte non relié à Windsor ou campagnes en pause).
N'invente aucun chiffre absent des données.
`;

async function analyser(donnees) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      system: CONTEXTE,
      messages: [{ role: "user", content: `${INSTRUCTIONS}\n\nDONNÉES :\n${JSON.stringify(donnees, null, 2)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const texte = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(texte.slice(texte.indexOf("{"), texte.lastIndexOf("}") + 1));
}

// ---------- Email ----------

function tableauCampagnes(titre, campagnes) {
  const lignes = Object.entries(campagnes || {});
  if (!lignes.length) return `<h3>${titre}</h3><p style="color:#999;">Aucune donnée reçue.</p>`;
  const td = 'style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;"';
  return `<h3>${titre}</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <tr style="background:#f4f4f4;"><th style="text-align:left;padding:6px 8px;">Campagne</th><th ${td}>Dépense</th><th ${td}>Clics</th><th ${td}>CPC</th><th ${td}>Leads/conv.</th><th ${td}>Sem. préc.</th></tr>
    ${lignes
      .map(([nom, c]) => {
        const s = c.cette_semaine, p = c.semaine_precedente;
        return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${escapeHtml(nom)}</td>
          <td ${td}>${s.depense} €</td><td ${td}>${s.clics}</td><td ${td}>${s.cpc ?? "–"} €</td>
          <td ${td}>${s.leads_ou_conversions}</td><td ${td} title="dépense / leads">${p.depense} € / ${p.leads_ou_conversions}</td></tr>`;
      })
      .join("")}
  </table>`;
}

function construireEmail(a, donnees) {
  const alertes = (a.alertes || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  const actions = (a.actions || [])
    .map(
      (x, i) => `<div style="border-left:4px solid #1f7a4d;padding:8px 12px;margin:0 0 12px;background:#f6fbf8;">
        <strong>${i + 1}. ${escapeHtml(x.titre)}</strong><br>
        <span style="color:#555;">Pourquoi : ${escapeHtml(x.pourquoi)}</span><br>
        <span style="white-space:pre-wrap;">Comment : ${escapeHtml(x.comment)}</span></div>`
    )
    .join("");
  return `<div style="font-family:Arial,sans-serif;max-width:720px;">
    <h2>📊 Rapport pub hebdo — ${escapeHtml(donnees.periode.cette_semaine)}</h2>
    <p>${escapeHtml(a.synthese)}</p>
    <p><strong>Dépense :</strong> ${a.depense_totale ?? "–"} € · <strong>Leads réels :</strong> ${a.leads_reels ?? "–"} ·
       <strong>Coût par lead réel :</strong> ${a.cout_par_lead_reel ?? "–"} €</p>
    ${alertes ? `<h3>⚠️ Alertes</h3><ul>${alertes}</ul>` : ""}
    <h3>✅ Les 3 actions de la semaine</h3>${actions}
    ${a.suivi_semaine_derniere ? `<p><em>Suivi : ${escapeHtml(a.suivi_semaine_derniere)}</em></p>` : ""}
    ${tableauCampagnes("Meta Ads", donnees.meta)}
    ${tableauCampagnes("Google Ads", donnees.google)}
  </div>`;
}

// ---------- Handler ----------

export default async function handler(req, res) {
  const jeton = req.headers["authorization"] === `Bearer ${CRON_SECRET}` || req.query?.secret === CRON_SECRET;
  if (!CRON_SECRET || !jeton) return res.status(401).json({ error: "Non autorisé" });
  if (!WINDSOR_API_KEY || !ANTHROPIC_API_KEY) return res.status(500).json({ error: "WINDSOR_API_KEY ou ANTHROPIC_API_KEY manquante" });

  try {
    const hier = new Date(Date.now() - 86400000);
    const dateTo = jourISO(hier);
    const debutSemaine = jourISO(new Date(hier.getTime() - 6 * 86400000));
    const dateFrom = jourISO(new Date(hier.getTime() - 13 * 86400000));

    const donnees = {
      periode: {
        cette_semaine: `${debutSemaine} → ${dateTo}`,
        semaine_precedente: `${dateFrom} → ${jourISO(new Date(hier.getTime() - 7 * 86400000))}`,
      },
      erreurs_collecte: [],
    };

    for (const [cle, src] of Object.entries(SOURCES)) {
      try {
        donnees[cle] = agreger(await windsor(src.connector, src.fields, dateFrom, dateTo), cle, debutSemaine);
      } catch (e) {
        donnees[cle] = {};
        donnees.erreurs_collecte.push(`${cle} : ${e.message.slice(0, 200)}`);
      }
    }

    try {
      donnees.leads_supabase_par_source = await leadsSupabase(dateFrom, debutSemaine);
    } catch (e) {
      donnees.erreurs_collecte.push(`leads Supabase : ${e.message.slice(0, 200)}`);
    }

    // Rapport de la semaine dernière, pour le suivi des actions.
    try {
      const precedent = await supabaseRequest("rapports_pub?select=created_at,analyse&order=created_at.desc&limit=1");
      if (precedent?.[0]) {
        donnees.rapport_semaine_derniere = {
          date: precedent[0].created_at.slice(0, 10),
          actions: (precedent[0].analyse?.actions || []).map((x) => x.titre),
        };
      }
    } catch (e) {
      // table absente : pas bloquant
    }

    const a = await analyser(donnees);

    try {
      await supabaseRequest("rapports_pub", {
        method: "POST",
        body: JSON.stringify({ periode: donnees.periode.cette_semaine, donnees, analyse: a }),
      });
    } catch (e) {
      console.error("Agent pub — archivage:", e.message);
    }

    await sendSms(
      TWILIO_TO_NUMBER,
      `📊 Pub semaine : ${a.depense_totale ?? "?"} € → ${a.leads_reels ?? "?"} leads` +
        `${a.cout_par_lead_reel ? ` (${a.cout_par_lead_reel} €/lead)` : ""}\n` +
        (a.actions || []).map((x, i) => `${i + 1}. ${x.titre}`).join("\n") +
        `\nDétail dans ton email.`
    );
    await sendEmail(`📊 Rapport pub hebdo — ${donnees.periode.cette_semaine}`, construireEmail(a, donnees));

    return res.status(200).json({ success: true, analyse: a });
  } catch (err) {
    console.error("Agent pub error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
