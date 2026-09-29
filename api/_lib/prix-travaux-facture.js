// /api/_lib/prix-travaux-facture.js
// Génère la facture PDF d'un achat de l'estimateur particuliers (prix-travaux.html),
// avec toutes les coordonnées de Skyeco by RMS (RESINE MARBRE SOL).
// Dépendance : pdf-lib (à ajouter dans package.json).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const VENDEUR = {
  marque: 'Skyeco by RMS',
  raison: 'RESINE MARBRE SOL',
  forme: 'SASU au capital de 50 000 €',
  adresse1: '23 route de Corn er Hoet',
  adresse2: '56400 Brech, France',
  siret: 'SIRET 939 997 870 00018',
  rcs: 'RCS Lorient 939 997 870',
  tva: 'TVA intracommunautaire FR19939997870',
  ape: 'Code APE 4399D',
  contact: 'infos@ecosky.fr  |  06 45 68 83 94  |  skyeco.fr',
};

const NAVY = rgb(0x14 / 255, 0x30 / 255, 0x4a / 255);
const ORANGE = rgb(0xe8 / 255, 0x62 / 255, 0x2c / 255);
const GRIS = rgb(0.36, 0.38, 0.41);
const LIGNE = rgb(0.84, 0.87, 0.9);

// Montants au format français, sans espace insécable (non supporté par Helvetica)
export function euros(n) {
  const [e, c] = (Math.round(n * 100) / 100).toFixed(2).split('.');
  return e.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + c + ' €';
}
const propre = (t) => String(t ?? '').replace(/[\u202f\u00a0]/g, ' ').replace(/[^\x20-\x7e\u00a0-\u00ff€œŒ’‘“”–—…]/g, '');

export async function genererFacturePDF(f) {
  // f = { numero, date, payeLe, client:{nom, email, adresse}, lignes:[{designation, detail, ttc, tauxTva}], reference }
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, M = 50;
  const txt = (t, x, y, o = {}) => page.drawText(propre(t), { x, y, size: o.size || 10, font: o.bold ? bold : font, color: o.color || NAVY });
  const droite = (t, xDroit, y, o = {}) => {
    const f2 = o.bold ? bold : font, s = o.size || 10;
    txt(t, xDroit - f2.widthOfTextAtSize(propre(t), s), y, o);
  };

  // En-tête : logo (badge + mot SKYECO)
  page.drawRectangle({ x: M, y: 768, width: 34, height: 34, color: NAVY, borderRadius: 7 });
  page.drawRectangle({ x: M + 8, y: 775, width: 14, height: 20, color: rgb(0.96, 0.97, 0.98) });
  page.drawCircle({ x: M + 25, y: 779, size: 8, color: ORANGE });
  txt('SKY', M + 44, 778, { bold: true, size: 22 });
  txt('ECO', M + 44 + bold.widthOfTextAtSize('SKY', 22), 778, { bold: true, size: 22, color: ORANGE });
  txt('by RMS', M + 44, 765, { size: 9, color: GRIS });

  droite('FACTURE', W - M, 784, { bold: true, size: 20 });
  droite(`N° ${f.numero}`, W - M, 767, { bold: true, size: 11 });
  droite(`Date : ${f.date}`, W - M, 752, { size: 10, color: GRIS });

  // Vendeur
  let y = 715;
  txt('Vendeur', M, y, { bold: true, size: 9, color: GRIS });
  y -= 15; txt(`${VENDEUR.raison}, marque ${VENDEUR.marque}`, M, y, { bold: true });
  for (const l of [VENDEUR.forme, VENDEUR.adresse1, VENDEUR.adresse2, VENDEUR.siret, VENDEUR.rcs, VENDEUR.tva, VENDEUR.ape, VENDEUR.contact]) {
    y -= 13; txt(l, M, y, { size: 9 });
  }

  // Client
  let yc = 715; const xc = 330;
  txt('Client', xc, yc, { bold: true, size: 9, color: GRIS });
  yc -= 15; txt(f.client.nom || f.client.email, xc, yc, { bold: true });
  for (const l of (f.client.adresse || '').split('\n').filter(Boolean)) { yc -= 13; txt(l, xc, yc, { size: 9 }); }
  if (f.client.siret) { yc -= 13; txt(`SIRET ${f.client.siret}`, xc, yc, { size: 9 }); }
  if (f.client.nom) { yc -= 13; txt(f.client.email, xc, yc, { size: 9 }); }

  // Tableau
  y = 560;
  page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 22, color: NAVY });
  const cols = { des: M + 8, qte: 330, ht: 395, tva: 455, ttc: W - M - 8 };
  txt('Désignation', cols.des, y, { bold: true, size: 9, color: rgb(1, 1, 1) });
  txt('Qté', cols.qte, y, { bold: true, size: 9, color: rgb(1, 1, 1) });
  txt('PU HT', cols.ht, y, { bold: true, size: 9, color: rgb(1, 1, 1) });
  txt('TVA', cols.tva, y, { bold: true, size: 9, color: rgb(1, 1, 1) });
  droite('Total TTC', cols.ttc, y, { bold: true, size: 9, color: rgb(1, 1, 1) });

  let totHT = 0, totTVA = 0, totTTC = 0;
  y -= 30;
  for (const l of f.lignes) {
    const ht = Math.round((l.ttc / (1 + l.tauxTva)) * 100) / 100;
    const tv = Math.round((l.ttc - ht) * 100) / 100;
    totHT += ht; totTVA += tv; totTTC += l.ttc;
    txt(l.designation, cols.des, y, { bold: true, size: 10 });
    txt('1', cols.qte, y); txt(euros(ht), cols.ht, y); txt(`${String(l.tauxTva * 100).replace('.', ',')} %`, cols.tva, y);
    droite(euros(l.ttc), cols.ttc, y, { bold: true });
    if (l.detail) { y -= 13; txt(l.detail, cols.des, y, { size: 8.5, color: GRIS }); }
    y -= 12; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: LIGNE }); y -= 18;
  }

  // Totaux
  const xl = 360;
  for (const [lib, val, b] of [['Total HT', totHT], ['TVA 20 %', totTVA], ['Total TTC', totTTC, true]]) {
    txt(lib, xl, y, { bold: !!b, size: b ? 12 : 10 }); droite(euros(val), W - M - 8, y, { bold: !!b, size: b ? 12 : 10 }); y -= b ? 20 : 16;
  }
  y -= 8;
  page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 24, color: rgb(0.98, 0.89, 0.85) });
  txt(`Facture acquittée : payée le ${f.payeLe} par carte bancaire. Aucun montant restant dû.`, M + 10, y + 4, { bold: true, size: 9.5, color: ORANGE });

  // Mentions
  y -= 45;
  const mentions = f.mentions ? [`Référence de commande : ${f.reference}`, ...f.mentions] : [
    `Référence de commande : ${f.reference}`,
    'Contenu numérique fourni immédiatement après le paiement. Le client a demandé l\'accès immédiat à l\'estimation',
    'et renoncé à son droit de rétractation dès le début de son utilisation (article L221-28, 13° du Code de la consommation).',
    'Estimation indicative : elle ne constitue ni un devis, ni un diagnostic technique.',
    'Conditions générales de vente : skyeco.fr/cgv-estimateur.html',
  ];
  for (const m of mentions) { txt(m, M, y, { size: 8.5, color: GRIS }); y -= 12; }

  // Pied de page
  page.drawLine({ start: { x: M, y: 60 }, end: { x: W - M, y: 60 }, thickness: 0.7, color: LIGNE });
  const pied = `${VENDEUR.raison} (${VENDEUR.marque}), ${VENDEUR.forme}, ${VENDEUR.adresse1}, ${VENDEUR.adresse2}`;
  txt(pied, (W - font.widthOfTextAtSize(propre(pied), 7.5)) / 2, 46, { size: 7.5, color: GRIS });
  const pied2 = `${VENDEUR.siret}  |  ${VENDEUR.rcs}  |  ${VENDEUR.tva}`;
  txt(pied2, (W - font.widthOfTextAtSize(propre(pied2), 7.5)) / 2, 35, { size: 7.5, color: GRIS });

  return Buffer.from(await pdf.save());
}
