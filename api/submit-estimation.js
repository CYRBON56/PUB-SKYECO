// api/submit-estimation.js
// Reçoit les réponses du formulaire d'estimation détaillée (10 questions),
// calcule une estimation indicative, génère un PDF "ESTIMATEUR" (numéroté,
// non engageant), sauvegarde le lead dans Supabase, et envoie un SMS avec le
// lien du PDF à la fois au client et au propriétaire de RMS ECOSKY.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { LOGO_ECOSKY_BASE64 } from "./_logo-ecosky-base64.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const TWILIO_TO_NUMBER = process.env.TWILIO_TO_NUMBER; // numéro du propriétaire RMS ECOSKY
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Adresse d'envoi : doit appartenir à un domaine vérifié dans Resend (ex. estimation@ecoskybyrms.fr)
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "estimation@ecoskybyrms.fr";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "infos@ecosky.fr";

// Zone cœur : départements couverts sans réserve.
// Zone élargie : départements limitrophes acceptés, mais la plus-value de
// déplacement et la faisabilité restent à valider par un technicien.
const CORE_DEPARTMENTS = ["56", "29", "22", "35"];
const EXTENDED_DEPARTMENTS = ["44"];

const ENTREPRISE = {
  nom: "ECOSKY BY RMS",
  raisonSociale: "RMS EcoSky — RESINE MARBRE SOL, SASU au capital de 50 000 €",
  adresse: "23 route de Corn er Hoët",
  ville: "56400 BRECH",
  siret: "SIRET : 939 997 870 00018 — APE 4399D",
  rcs: "RCS Lorient 939 997 870",
  // RCS : ville du greffe à confirmer avant activation (ex. "RCS Lorient 939 997 870")
  assurance: "Assurance RC décennale n° SV75020721/11590 (ERGO France)",
  contact: "infos@ecosky.fr / c.bon@ecosky.fr",
};

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
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

function toE164(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("33")) return "+" + digits;
  if (digits.startsWith("0")) return "+33" + digits.slice(1);
  return "+" + digits;
}

async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !to) {
    console.error("Twilio: configuration manquante ou numéro absent, SMS non envoyé.");
    return false;
  }
  try {
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body });
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );
    if (!res.ok) {
      console.error("Twilio SMS error:", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendSms error:", err.message);
    return false;
  }
}

// Envoi d'email via l'API Resend (https://resend.com). Contrairement au SMS
// Twilio (bloqué en mode trial pour tout numéro non vérifié), l'email n'a
// pas cette limitation — c'est pourquoi il sert de canal de secours/parallèle
// tant que le compte Twilio n'est pas passé en payant. PDF joint en base64
// quand disponible ; sinon, le mail part quand même avec le texte seul.
async function sendEmail({ to, subject, html, pdfBytes, pdfFilename, includeLogo }) {
  if (!RESEND_API_KEY || !to) {
    console.error("Resend: configuration manquante ou destinataire absent, email non envoyé.");
    return false;
  }
  try {
    const payload = { from: RESEND_FROM_EMAIL, to: [to], subject, html };
    const attachments = [];
    if (includeLogo) {
      attachments.push({
        filename: "logo-ecosky.jpg",
        content: LOGO_ECOSKY_BASE64,
        content_id: "logo-ecosky",
      });
    }
    if (pdfBytes) {
      attachments.push({
        filename: pdfFilename || "estimation.pdf",
        content: Buffer.from(pdfBytes).toString("base64"),
      });
    }
    if (attachments.length > 0) payload.attachments = attachments;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("Resend email error:", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendEmail error:", err.message);
    return false;
  }
}

// Template HTML professionnel pour l'email client : en-tête avec logo,
// message clair (transmission + rappel que le technicien doit affiner),
// bloc estimation, et pied de page avec les mentions légales — cohérent
// avec le PDF joint et le bandeau de confiance du formulaire.
function buildClientEmailHtml({ prenom, estimation, numero, remiseHtml }) {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #14312a;">
    <div style="text-align:center; padding: 24px 0 8px;">
      <img src="cid:logo-ecosky" alt="ECOSKY BY RMS" width="90" style="display:inline-block;" />
    </div>
    <div style="background: white; border: 1px solid #e2e0d5; border-radius: 14px; padding: 28px 26px;">
      <p style="font-size: 15px; margin: 0 0 14px;">Bonjour ${prenom || ""},</p>
      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 18px;">
        Nous vous transmettons votre estimation pour votre projet, comme demandé sur notre formulaire en ligne.
      </p>
      <div style="background: #eaf4ef; border: 1.5px solid #1e6f4c; border-radius: 10px; padding: 18px 20px; margin: 0 0 18px;">
        <div style="font-size: 12.5px; color: #4a5a54; margin-bottom: 4px;">Estimation indicative</div>
        <div style="font-size: 24px; font-weight: 800; color: #14312a; margin-bottom: 8px;">${estimation.chiffrable ? estimation.montantTTC + " € TTC" : ""}</div>
        <div style="font-size: 13.5px; color: #4a5a54; line-height: 1.5;">${estimation.texte}</div>
      </div>
      ${remiseHtml}
      <p style="font-size: 13.5px; line-height: 1.6; color: #4a5a54; margin: 18px 0 0; padding-top: 16px; border-top: 1px solid #e2e0d5;">
        ⚠️ Cette estimation est indicative et devra être affinée avec un technicien RMS EcoSky, lors d'un appel
        ou d'une visite sur site, avant toute confirmation définitive du prix.
      </p>
      <p style="font-size: 14px; margin: 18px 0 0;">
        Le détail complet de votre estimateur (n°${numero}) se trouve en pièce jointe.
      </p>
      <p style="font-size: 14px; margin: 18px 0 0;">À très vite !<br/>L'équipe RMS EcoSky</p>
    </div>
    <div style="text-align:center; font-size: 11px; color: #8a9490; line-height: 1.6; padding: 18px 10px;">
      RMS EcoSky — RESINE MARBRE SOL, SASU au capital de 50 000 € — SIRET 939 997 870 00018 — RCS Lorient 939 997 870<br/>
      23 route de Corn Er Hoët, 56400 Brech — Assurance RC décennale n° SV75020721/11590 (ERGO France)<br/>
      <a href="https://www.ecoskybyrms.fr" style="color:#1e6f4c;">ecoskybyrms.fr</a> — <a href="mailto:infos@ecosky.fr" style="color:#1e6f4c;">infos@ecosky.fr</a>
    </div>
  </div>`;
}

// ---------- Calcul de l'estimation ----------
// Reprend exactement les mêmes règles de prix que Skyeco (chat), pour rester
// cohérent partout : 115€ HT/m² sur dalle existante, à partir de 150€ HT/m²
// pour un parking carrossable. Les autres cas (terrain nu, etc.) ne sont pas
// chiffrables en ligne de façon fiable — on l'indique clairement plutôt que
// d'inventer un prix.
function computeEstimation(answers) {
  const surface = parseFloat(answers.surface);
  const usage = answers.usage; // "pieton" | "carrossable"
  const batimentAncien = answers.age_batiment === "plus_2_ans";
  const tauxTVA = batimentAncien ? 0.10 : 0.20;

  if (!surface || surface < 10) {
    return {
      chiffrable: false,
      texte:
        "RMS ECOSKY n'intervient pas pour des surfaces inférieures à 10 m². N'hésitez pas à nous recontacter si votre projet évolue.",
    };
  }

  let prixM2 = null;
  let note = "";
  let chiffrable = true;

  if (usage === "pieton") {
    const support = answers.support_pieton; // "dalle_beton" | "carrelage" | "pave" | "terrain_nu"

    if (support === "dalle_beton") {
      prixM2 = 115;
      note =
        answers.etat_dalle === "a_reprendre"
          ? "une plus-value sera à prévoir pour la réparation de la dalle, montant à valider par un technicien"
          : "sous réserve de la qualité réelle de la dalle, à confirmer";
    } else if (support === "carrelage") {
      if (answers.enlevement_carrelage === "client") {
        prixM2 = 115;
        note = "prix applicable une fois les carreaux existants retirés par vos soins";
      } else {
        // RMS ECOSKY doit retirer les carreaux : pas de prix fixe en ligne
        chiffrable = false;
      }
    } else if (support === "pave") {
      prixM2 = 115;
      note =
        "prix de départ : le tarif définitif dépend de l'état des pavés existants et sera validé par un technicien";
    } else {
      // terrain nu, usage piéton : pas de tarif en ligne
      chiffrable = false;
    }
  } else if (usage === "carrossable") {
    if (answers.etat_terrain_carrossable === "terre_nue") {
      prixM2 = 180;
      note = "comprend terrassement, évacuation, pose d'un concassé, profilage et compactage";
    } else if (answers.etat_terrain_carrossable === "deja_prepare") {
      prixM2 = 150;
      note = "terrain déjà préparé, tarif à valider avec un technicien";
    }
    if (prixM2 && answers.couleur_granulat === "autre") {
      prixM2 += 50;
      note += " — plus-value couleur incluse (hors granulat quartz beige/jaune standard)";
    }
  }

  if (!chiffrable || !prixM2) {
    return {
      chiffrable: false,
      texte:
        "Ce type de projet nécessite une évaluation par un technicien pour être chiffré de façon fiable — nous vous recontactons rapidement.",
    };
  }

  const montantHT = Math.round(prixM2 * surface);

  let bordureHT = 0;
  let bordureTexte = "";
  if (usage === "carrossable" && answers.bordure === "oui" && answers.bordure_metres) {
    const metres = parseFloat(answers.bordure_metres);
    if (metres > 0) {
      bordureHT = Math.round(45 * metres);
      bordureTexte = ` + ${bordureHT}€ HT de bordure (${metres}m linéaires à 45€ HT/m)`;
    }
  }

  const totalHT = montantHT + bordureHT;
  const montantTTC = Math.round(totalHT * (1 + tauxTVA));

  // Remise selon le volume (montant TTC de l'estimation) : 5% en dessous de
  // 5 000€, 10% entre 5 000€ et 10 000€, 15% à partir de 10 000€. Cette
  // remise n'est PAS automatiquement appliquée au prix final : elle est
  // affichée à titre indicatif, à confirmer avec un technicien.
  let remisePourcent = 5;
  if (montantTTC >= 10000) remisePourcent = 15;
  else if (montantTTC >= 5000) remisePourcent = 10;
  const remiseMontant = Math.round(montantTTC * (remisePourcent / 100));
  const montantApresRemise = montantTTC - remiseMontant;

  return {
    chiffrable: true,
    prixM2,
    montantHT: totalHT,
    montantTTC,
    remisePourcent,
    remiseMontant,
    montantApresRemise,
    tauxTVA: batimentAncien ? "10%" : "20%",
    texte: `Estimation indicative : ${prixM2}€ HT/m² × ${surface}m² = ${montantHT}€ HT${bordureTexte}, soit environ ${montantTTC}€ TTC (TVA ${batimentAncien ? "10%" : "20%"}) — ${note}.`,
  };
}

// Détermine le statut de zone d'un code postal :
// "core"     -> département couvert sans réserve (56, 29, 22, 35)
// "extended" -> département limitrophe accepté, mais plus-value déplacement
//               et faisabilité à valider par un technicien (44)
// "out"      -> hors zone, refus automatique
function getZoneStatus(codePostal) {
  if (!codePostal) return "core";
  const dept = String(codePostal).trim().slice(0, 2);
  if (CORE_DEPARTMENTS.includes(dept)) return "core";
  if (EXTENDED_DEPARTMENTS.includes(dept)) return "extended";
  return "out";
}

// ---------- Numérotation séquentielle (E-2026-07-001, E-2026-07-002...) ----------
async function nextEstimationNumber() {
  const now = new Date();
  const prefix = `E-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-`;
  try {
    const rows = await supabaseRequest(
      `leads?estimation_numero=like.${encodeURIComponent(prefix)}*&select=estimation_numero`
    );
    const count = (rows || []).length;
    return prefix + String(count + 1).padStart(3, "0");
  } catch (err) {
    // En cas d'échec de la numérotation, on retombe sur un identifiant basé sur
    // l'horodatage plutôt que de bloquer tout le processus.
    return prefix + String(Date.now()).slice(-4);
  }
}

// ---------- Génération du PDF "ESTIMATEUR" ----------
const SUPPORT_LABELS = {
  dalle_beton: "Dalle béton existante",
  carrelage: "Carrelage existant",
  pave: "Pavé autobloquant existant",
  terrain_nu: "Terrain nu",
};
const USAGE_LABELS = { pieton: "Usage piéton", carrossable: "Usage carrossable (véhicule)" };

// Désignation technique détaillée des travaux, selon le type de pose choisi
// par le client dans le formulaire. Utilisée dans le PDF pour lister
// précisément ce que comprend l'intervention.
function buildDesignationLines(answers) {
  if (answers.usage === "pieton") {
    return [
      "PRESTATION COMPRISE (forfait de base) :",
      "Ponçage / surfaçage de la surface au disque diamant, aspiration des",
      "poussières, nettoyage complet du support, pose de la primaire",
      "d'accrochage, application du revêtement résine EcoSky'Gum.",
      "OPTIONS SELON L'ÉTAT DU SUPPORT (en supplément) :",
      "- Remise à niveau / réparation de la dalle si détériorée",
      "- Pose d'un filet de renfort (trame PVC) sur zones fragilisées",
      "- Pose et collage des baguettes de finition (métrage variable)",
      "Ces options ne peuvent être chiffrées qu'après déplacement d'un",
      "technicien sur le chantier — l'estimation ci-dessus ne porte que sur",
      "les éléments qui peuvent être déterminés à distance.",
    ];
  }
  if (answers.usage === "carrossable" && answers.etat_terrain_carrossable === "terre_nue") {
    return [
      "POSE POUR PARKING SUR TERRAIN NU :",
      "Terrassement pour décaissement et évacuation du déblai, fourniture et",
      "pose d'un concassé 0/31,5 sur 10cm, profilage et compactage, pose des",
      "bordures si besoin, pose du revêtement quartz, granit ou marbre.",
    ];
  }
  if (answers.usage === "carrossable" && answers.etat_terrain_carrossable === "deja_prepare") {
    return [
      "POSE PARKING (terrain déjà préparé) :",
      "Pose du revêtement quartz, granit ou marbre sur terrain déjà stabilisé,",
      "pose des bordures si besoin.",
    ];
  }
  return [];
}

async function generateEstimatePdf({ numero, nom, prenom, adresse_projet, code_postal, telephone, email, answers, estimation }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const green = rgb(0.118, 0.435, 0.298); // #1e6f4c
  const dark = rgb(0.08, 0.09, 0.09);
  const grey = rgb(0.4, 0.42, 0.4);
  const lightBg = rgb(0.918, 0.957, 0.937);

  let y = 800;
  const marginX = 50;
  const pageWidth = 595.28;

  function text(str, x, yy, opts = {}) {
    page.drawText(String(str), {
      x,
      y: yy,
      size: opts.size || 10,
      font: opts.bold ? fontBold : font,
      color: opts.color || dark,
    });
  }
  function line(yy, color = rgb(0.85, 0.84, 0.8)) {
    page.drawLine({ start: { x: marginX, y: yy }, end: { x: pageWidth - marginX, y: yy }, thickness: 1, color });
  }

  // Logo en haut à gauche
  let headerTextX = marginX;
  try {
    const logoBytes = Uint8Array.from(Buffer.from(LOGO_ECOSKY_BASE64, "base64"));
    const logoImage = await doc.embedJpg(logoBytes);
    const logoWidth = 60;
    const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
    page.drawImage(logoImage, { x: marginX, y: 800 - logoHeight + 8, width: logoWidth, height: logoHeight });
    headerTextX = marginX + logoWidth + 12;
  } catch (logoErr) {
    // Un échec d'intégration du logo ne doit jamais bloquer la génération du PDF.
    console.error("Logo PDF embed error:", logoErr.message);
  }

  // En-tête entreprise (gauche)
  text(ENTREPRISE.nom, headerTextX, y, { bold: true, size: 15, color: green });
  y -= 16;
  text(ENTREPRISE.adresse, headerTextX, y, { size: 9, color: grey });
  y -= 12;
  text(ENTREPRISE.ville, headerTextX, y, { size: 9, color: grey });
  y -= 12;
  text(ENTREPRISE.siret, headerTextX, y, { size: 9, color: grey });
  y -= 12;
  text(ENTREPRISE.contact, headerTextX, y, { size: 9, color: grey });

  // Titre ESTIMATEUR (droite)
  text("ESTIMATEUR", pageWidth - marginX - 150, 800, { bold: true, size: 22, color: dark });
  text("Document non contractuel", pageWidth - marginX - 150, 782, { size: 9, color: grey });
  text(`N° ${numero}`, pageWidth - marginX - 150, 764, { bold: true, size: 10 });
  const dateStr = new Date().toLocaleDateString("fr-FR");
  text(`Date : ${dateStr}`, pageWidth - marginX - 150, 750, { size: 9, color: grey });

  y -= 30;
  line(y);
  y -= 26;

  // Bloc client / chantier
  text("CLIENT", marginX, y, { bold: true, size: 10, color: green });
  text("ADRESSE DU PROJET", marginX + 280, y, { bold: true, size: 10, color: green });
  y -= 14;
  text(`${prenom || ""} ${nom || ""}`.trim(), marginX, y, { size: 10 });
  text(`${adresse_projet || "-"}`, marginX + 280, y, { size: 10 });
  y -= 13;
  text(telephone || "-", marginX, y, { size: 9.5, color: grey });
  text(code_postal ? `${code_postal}` : "-", marginX + 280, y, { size: 9.5, color: grey });
  y -= 13;
  if (email) {
    text(email, marginX, y, { size: 9.5, color: grey });
    y -= 13;
  }

  y -= 16;
  text(
    `Objet : ${USAGE_LABELS[answers.usage] || ""} — ${SUPPORT_LABELS[answers.support_pieton] || (answers.usage === "carrossable" ? "Parking / allée carrossable" : "")}`,
    marginX,
    y,
    { bold: true, size: 10.5 }
  );

  y -= 26;

  // Tableau estimation
  const tableTop = y;
  page.drawRectangle({ x: marginX, y: tableTop - 20, width: pageWidth - marginX * 2, height: 20, color: lightBg });
  text("Désignation", marginX + 8, tableTop - 14, { bold: true, size: 9.5 });
  text("Estimation HT", pageWidth - marginX - 110, tableTop - 14, { bold: true, size: 9.5 });
  y = tableTop - 20;

  function tableRow(label, amount) {
    y -= 22;
    text(label, marginX + 8, y + 6, { size: 9.5 });
    if (amount !== null) text(amount, pageWidth - marginX - 110, y + 6, { size: 9.5 });
    line(y);
  }

  if (estimation.chiffrable) {
    tableRow(
      `${SUPPORT_LABELS[answers.support_pieton] || USAGE_LABELS[answers.usage]} — ${answers.surface} m² × ${estimation.prixM2}€ HT/m²`,
      `${estimation.montantHT} € HT`
    );
    if (answers.bordure === "oui" && answers.bordure_metres) {
      tableRow(`Bordure — ${answers.bordure_metres} m linéaires × 45€ HT/m`, null);
    }

    // Désignation technique détaillée des travaux compris dans le prix
    const designationLines = buildDesignationLines(answers);
    if (designationLines.length > 0) {
      y -= 6;
      designationLines.forEach((lineText, i) => {
        text(lineText, marginX + 8, y, { size: 8, color: grey, bold: i === 0 });
        y -= 11;
      });
    }

    y -= 24;
    const tauxTVA = estimation.tauxTVA;
    text("Sous-total HT", pageWidth - marginX - 220, y, { size: 9.5 });
    text(`${estimation.montantHT} €`, pageWidth - marginX - 110, y, { size: 9.5 });
    y -= 15;
    text(`TVA ${tauxTVA}`, pageWidth - marginX - 220, y, { size: 9.5 });
    y -= 15;
    page.drawRectangle({ x: pageWidth - marginX - 230, y: y - 8, width: 230, height: 22, color: lightBg });
    text("ESTIMATION TTC", pageWidth - marginX - 220, y, { bold: true, size: 10.5 });
    text(`${estimation.montantTTC} €`, pageWidth - marginX - 110, y, { bold: true, size: 12, color: green });
    y -= 34;
    text(`Remise de ${estimation.remisePourcent}% possible selon le volume, à confirmer avec un`, marginX, y, {
      size: 9,
      color: green,
    });
    y -= 12;
    text(
      `technicien : ${estimation.remiseMontant} € offerts, soit ${estimation.montantApresRemise} € TTC au lieu de ${estimation.montantTTC} €.`,
      marginX,
      y,
      { size: 9, color: green }
    );
    y -= 26;
  } else {
    tableRow("Ce projet nécessite une évaluation par un technicien", null);
    y -= 20;
  }

  text(estimation.texte, marginX, y, { size: 8.5, color: grey });
  y -= 40;

  // Conditions — protège explicitement RMS ECOSKY
  text("CONDITIONS DE CET ESTIMATEUR", marginX, y, { bold: true, size: 10.5, color: green });
  y -= 18;

  const conditions = [
    "Ce document est un ESTIMATEUR indicatif généré automatiquement à partir des informations",
    "déclarées par le client. Il ne constitue en aucun cas un devis ferme et définitif, et n'a fait",
    "l'objet d'aucune visite technique préalable.",
    "",
    "Le prix définitif ne pourra être établi qu'après confirmation de l'état réel du support et des",
    "contraintes du chantier par un technicien RMS ECOSKY, lors d'un appel téléphonique puis, le cas",
    "échéant, d'une visite sur site.",
    "",
    "Cet estimatif n'emporte aucun engagement contractuel, ni de la part de RMS ECOSKY, ni du client.",
    "Il ne vaut ni acceptation de commande, ni réservation de créneau d'intervention, et ne peut donner",
    "lieu à aucune réclamation.",
    "",
    `Validité indicative de 30 jours à compter du ${dateStr}, au-delà de laquelle les tarifs pourront`,
    "évoluer.",
  ];
  conditions.forEach((lineText) => {
    text(lineText, marginX, y, { size: 8.5, color: grey });
    y -= 12;
  });

  y -= 10;
  line(y);
  y -= 18;
  text("Aucune signature requise à ce stade — document d'information uniquement.", marginX, y, {
    size: 9,
    color: grey,
  });

  y -= 20;
  line(y);
  y -= 14;
  text(
    `${ENTREPRISE.raisonSociale} — ${ENTREPRISE.siret} — ${ENTREPRISE.rcs}`,
    marginX,
    y,
    { size: 7.5, color: grey }
  );
  y -= 11;
  text(
    `${ENTREPRISE.assurance} — ${ENTREPRISE.adresse}, ${ENTREPRISE.ville}`,
    marginX,
    y,
    { size: 7.5, color: grey }
  );

  return doc.save();
}

async function uploadPdfToSupabase(bytes, filename) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/media/estimateurs/${filename}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`Supabase storage upload error ${res.status}: ${await res.text()}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/media/estimateurs/${filename}`;
}

// 🤖 Déclenche l'agent IA (api/agent-leads.js) sur ce lead, sans ralentir le
// formulaire : on n'attend pas l'analyse (coupure après 1,5 s, l'agent continue
// de tourner de son côté). Un échec ici ne bloque jamais le client.
async function declencherAgentLeads(leadId) {
  if (!leadId || !process.env.CRON_SECRET) return;
  try {
    await fetch(`https://salesflow-ecosky.vercel.app/api/agent-leads?lead_id=${encodeURIComponent(leadId)}`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(1500),
    });
  } catch (e) {
    // Timeout attendu : l'agent poursuit son analyse en arrière-plan.
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const body = req.body || {};
    const {
      nom,
      prenom,
      telephone,
      email,
      adresse_projet,
      code_postal,
      type_projet,
      answers, // objet avec toutes les réponses détaillées (état, usage, surface, âge bâtiment, délai, coloris...)
    } = body;

    if (!nom || !telephone) {
      return res.status(400).json({ success: false, error: "Nom et téléphone requis." });
    }

    const phoneE164 = toE164(telephone);
    const estimation = computeEstimation(answers || {});
    const zoneStatus = getZoneStatus(code_postal); // "core" | "extended" | "out"
    const inZone = zoneStatus !== "out";
    const isExtendedZone = zoneStatus === "extended";

    const numero = await nextEstimationNumber();

    let pdfUrl = null;
    let pdfBytes = null;
    try {
      pdfBytes = await generateEstimatePdf({
        numero,
        nom,
        prenom,
        adresse_projet,
        code_postal,
        telephone,
        email,
        answers: answers || {},
        estimation,
      });
      const filename = `${numero}.pdf`;
      pdfUrl = await uploadPdfToSupabase(pdfBytes, filename);
    } catch (pdfErr) {
      // Un échec de génération/upload du PDF ne doit jamais empêcher
      // l'enregistrement du lead ni l'envoi du SMS/email avec le texte seul.
      console.error("PDF estimateur error:", pdfErr.message);
    }

    const leadPayload = {
      nom,
      prenom: prenom || null,
      telephone: phoneE164 || telephone,
      email: email || null,
      adresse_projet: adresse_projet || null,
      code_postal: code_postal || null,
      type_projet: type_projet || null,
      reponses_estimation: answers || {},
      estimation_texte: estimation.texte,
      estimation_numero: numero,
      estimation_pdf_url: pdfUrl,
      source: "Formulaire estimation détaillée",
      formulaire_complete: true,
      notes: isExtendedZone
        ? "SECTEUR ÉLARGI (44) — vérifier distance, plus-value déplacement possible"
        : "",
    };

    // Le téléphone est unique dans la table leads : si un dossier existe déjà
    // pour ce numéro (contact précédent par WhatsApp, chat, ou une estimation
    // antérieure), on le MET À JOUR avec cette nouvelle estimation plutôt que
    // d'essayer d'en créer un doublon, ce qui échouerait systématiquement.
    const existing = await supabaseRequest(
      `leads?telephone=eq.${encodeURIComponent(phoneE164 || telephone)}`
    );

    let lead;
    if (existing && existing.length > 0) {
      lead = await supabaseRequest(`leads?telephone=eq.${encodeURIComponent(phoneE164 || telephone)}`, {
        method: "PATCH",
        body: JSON.stringify(leadPayload),
      });
    } else {
      lead = await supabaseRequest("leads", {
        method: "POST",
        body: JSON.stringify({ ...leadPayload, statut: "nouveau" }),
      });
    }

    // SMS au client avec son estimation (zone cœur = message normal, zone
    // élargie = même message + précision sur la validation distance, hors
    // zone = refus poli).
    if (phoneE164 && inZone) {
      const pdfLine = pdfUrl ? ` Votre estimateur détaillé (n°${numero}) : ${pdfUrl}` : "";
      const remiseLine = estimation.chiffrable
        ? ` 🎁 Remise de ${estimation.remisePourcent}% possible selon le volume (${estimation.montantApresRemise}€ TTC au lieu de ${estimation.montantTTC}€) — contactez un technicien pour voir si vous pouvez en bénéficier.`
        : "";
      const zoneLine = isExtendedZone
        ? " Votre secteur étant un peu excentré, une éventuelle plus-value de déplacement sera à valider par le technicien."
        : "";
      const clientMessage =
        `Bonjour ${prenom || ""}, merci pour votre demande sur RMS ECOSKY ! ` +
        `${estimation.texte} Cette estimation reste indicative et sera confirmée par l'un de nos techniciens lors d'un appel.${remiseLine}${zoneLine}${pdfLine} À très vite !`;
      await sendSms(phoneE164, clientMessage);
    } else if (phoneE164 && !inZone) {
      await sendSms(
        phoneE164,
        "Bonjour, merci pour votre demande. Malheureusement RMS ECOSKY n'intervient pas dans votre secteur pour le moment. Bonne continuation dans votre projet !"
      );
    }

    // SMS au propriétaire : nouveau lead qualifié avec toutes les réponses
    const zoneNote = isExtendedZone
      ? "\n⚠️ SECTEUR ÉLARGI (44) — vérifier distance, plus-value déplacement possible"
      : "";
    const ownerMessage =
      `🔔 Nouvelle estimation détaillée ! (n°${numero})\n${prenom || ""} ${nom} — ${telephone}\n` +
      `${type_projet || ""}${code_postal ? " — " + code_postal : ""}${zoneNote}\n` +
      `${estimation.texte}${pdfUrl ? "\nPDF : " + pdfUrl : ""}`;
    await sendSms(TWILIO_TO_NUMBER, ownerMessage);

    // Email au client avec son estimateur en pièce jointe. Canal indépendant
    // du SMS Twilio (qui reste bloqué en mode trial pour les numéros non
    // vérifiés) — l'email part donc même quand le SMS client échoue.
    if (email && inZone) {
      const remiseHtml = estimation.chiffrable
        ? `<div style="background:#fff7e6; border:1.5px solid #e8b74a; border-radius:10px; padding:14px 16px; margin:0 0 18px; font-size:13.5px;">🎁 <strong>Remise de ${estimation.remisePourcent}% possible selon le volume</strong> (${estimation.montantApresRemise}€ TTC au lieu de ${estimation.montantTTC}€) — contactez un technicien pour voir si vous pouvez en bénéficier.</div>`
        : "";
      const clientHtml = buildClientEmailHtml({ prenom, estimation, numero, remiseHtml });
      await sendEmail({
        to: email,
        subject: `Votre estimation RMS EcoSky n°${numero}`,
        html: clientHtml,
        pdfBytes,
        pdfFilename: `estimation-${numero}.pdf`,
        includeLogo: true,
      });
    } else if (email && !inZone) {
      await sendEmail({
        to: email,
        subject: "Votre demande RMS EcoSky",
        html: "<p>Bonjour, merci pour votre demande. Malheureusement RMS ECOSKY n'intervient pas dans votre secteur pour le moment. Bonne continuation dans votre projet !</p>",
      });
    }

    // Email au propriétaire : copie de la notification, avec le PDF joint
    await sendEmail({
      to: OWNER_EMAIL,
      subject: `🔔 Nouvelle estimation détaillée n°${numero} — ${prenom || ""} ${nom}`,
      html:
        `<p>${prenom || ""} ${nom} — ${telephone}</p>` +
        `<p>${type_projet || ""}${code_postal ? " — " + code_postal : ""}${isExtendedZone ? " — ⚠️ secteur élargi (44)" : ""}</p>` +
        `<p>${estimation.texte}</p>` +
        (pdfUrl ? `<p>PDF : <a href="${pdfUrl}">${pdfUrl}</a></p>` : ""),
      pdfBytes,
      pdfFilename: `estimation-${numero}.pdf`,
    });

    await declencherAgentLeads(lead?.[0]?.id);

    return res.status(200).json({ success: true, estimation, lead_id: lead?.[0]?.id, numero, pdf_url: pdfUrl });
  } catch (err) {
    console.error("submit-estimation error:", err.message);
    return res.status(200).json({
      success: false,
      error: "Une erreur technique est survenue. Un conseiller RMS ECOSKY vous recontactera.",
    });
  }
}
