import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { RecordSnapshot } from "./data";
import { CATEGORY_LABELS, RATING_LABELS, safeJson } from "./data";

const A4: [number, number] = [595.28, 841.89];
const NAVY = rgb(0.05, 0.14, 0.2);
const CYAN = rgb(0.09, 0.66, 0.82);
const INK = rgb(0.08, 0.14, 0.18);
const MUTED = rgb(0.38, 0.46, 0.5);
const LINE = rgb(0.84, 0.89, 0.91);
const PALE = rgb(0.95, 0.97, 0.98);

type Cursor = {
  doc: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
  pages: PDFPage[];
};

export async function generateFinalPdf(
  snapshot: RecordSnapshot,
  signatureImages: Map<string, Uint8Array>,
): Promise<Uint8Array> {
  if (!snapshot.finalEvaluation) throw new Error("FINAL_EVALUATION_REQUIRED");
  const doc = await PDFDocument.create();
  doc.setTitle(`Suivi de stage - ${snapshot.trainee.first_name} ${snapshot.trainee.last_name} - v${snapshot.trainee.record_version}`);
  doc.setAuthor("GHE - Encadrement brancardage");
  doc.setSubject("Évaluation définitive de stage");
  doc.setCreator("responsable.esapin.com");
  doc.setProducer("Cloudflare Worker");
  doc.setCreationDate(new Date());
  const cursor: Cursor = {
    doc,
    page: doc.addPage(A4),
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    y: 0,
    pages: [],
  };
  cursor.pages.push(cursor.page);
  drawHeader(cursor, "FICHE DE SUIVI DE STAGE");

  section(cursor, "IDENTIFICATION DU STAGIAIRE");
  infoGrid(cursor, [
    ["Stagiaire", `${snapshot.trainee.first_name} ${snapshot.trainee.last_name}`],
    ["Référence", snapshot.trainee.public_ref],
    ["Établissement / école", snapshot.trainee.school || "Non renseigné"],
    ["Période", `${formatDate(snapshot.trainee.start_date)} au ${formatDate(snapshot.trainee.end_date)}`],
    ["Tuteur référent", snapshot.trainee.tutor_name || "Non renseigné"],
    ["Version définitive", `Version ${snapshot.trainee.record_version}`],
  ]);

  if (snapshot.trainee.arrival_notes) {
    section(cursor, "REPÈRES À L’ARRIVÉE");
    paragraph(cursor, snapshot.trainee.arrival_notes);
  }

  section(cursor, "OBSERVATIONS DE TERRAIN");
  if (!snapshot.observations.length) paragraph(cursor, "Aucune observation de terrain enregistrée.", true);
  for (const observation of snapshot.observations) {
    const signature = snapshot.signatures.find(item => item.scope_type === "OBSERVATION" && item.scope_id === observation.id);
    ensure(cursor, 52);
    cursor.page.drawRectangle({ x: 42, y: cursor.y - 35, width: 511, height: 35, color: PALE, borderColor: LINE, borderWidth: 0.7 });
    cursor.page.drawText(clean(`${CATEGORY_LABELS[observation.category] || observation.category} · ${formatDate(observation.observed_on)} · version ${observation.record_version}`), {
      x: 52, y: cursor.y - 14, size: 9.5, font: cursor.bold, color: NAVY,
    });
    cursor.page.drawText(clean(`${observation.author_name} · ${signature ? "observation signée" : "observation non signée"}`), {
      x: 52, y: cursor.y - 27, size: 7.5, font: cursor.regular, color: MUTED,
    });
    cursor.y -= 43;
    paragraph(cursor, observation.content);
    cursor.y -= 4;
  }

  if (snapshot.selfSection) {
    section(cursor, "EXPRESSION DU STAGIAIRE");
    labeledParagraph(cursor, "Attentes", snapshot.selfSection.expectations);
    labeledParagraph(cursor, "Progression ressentie", snapshot.selfSection.progress);
    labeledParagraph(cursor, "Retour sur le stage", snapshot.selfSection.feedback);
    labeledParagraph(cursor, "Commentaires", snapshot.selfSection.comments);
  }

  section(cursor, "ÉVALUATION SYNTHÉTIQUE FINALE");
  const ratings = safeJson(snapshot.finalEvaluation.ratings_json) as Record<string, unknown>;
  for (const [key, label] of Object.entries(RATING_LABELS)) {
    ensure(cursor, 25);
    cursor.page.drawLine({ start: { x: 42, y: cursor.y - 20 }, end: { x: 553, y: cursor.y - 20 }, color: LINE, thickness: 0.6 });
    cursor.page.drawText(clean(label), { x: 47, y: cursor.y - 14, size: 9, font: cursor.regular, color: INK });
    cursor.page.drawText(ratingText(ratings[key]), { x: 430, y: cursor.y - 14, size: 9, font: cursor.bold, color: NAVY });
    cursor.y -= 22;
  }
  cursor.y -= 5;
  labeledParagraph(cursor, "Points forts", snapshot.finalEvaluation.strengths);
  labeledParagraph(cursor, "Points à améliorer", snapshot.finalEvaluation.improvements);
  labeledParagraph(cursor, "Synthèse du responsable", snapshot.finalEvaluation.summary);

  section(cursor, "SIGNATURES ET PORTÉE DES ATTESTATIONS");
  paragraph(cursor, "Chaque agent signe uniquement l’observation qu’il a personnellement rédigée ; sa signature ne valide pas l’intégralité de l’évaluation. La signature de l’expression du stagiaire atteste ses propres propos. Sa signature finale atteste seulement la prise de connaissance du bilan correspondant à cette version, sans valoir accord avec chaque appréciation.", true);
  for (const signature of snapshot.signatures) {
    ensure(cursor, 68);
    cursor.page.drawRectangle({ x: 42, y: cursor.y - 55, width: 511, height: 55, borderColor: LINE, borderWidth: 0.7 });
    cursor.page.drawText(clean(signature.signer_name), { x: 52, y: cursor.y - 16, size: 9, font: cursor.bold, color: NAVY });
    cursor.page.drawText(clean(`${roleLabel(signature.signer_role)} · ${scopeLabel(signature.scope_type)} · ${formatDateTime(signature.created_at)}`), {
      x: 52, y: cursor.y - 30, size: 7.5, font: cursor.regular, color: MUTED,
    });
    const imageBytes = signatureImages.get(signature.id);
    if (imageBytes) {
      try {
        const image = await doc.embedPng(imageBytes);
        const fitted = image.scaleToFit(105, 38);
        cursor.page.drawImage(image, { x: 435, y: cursor.y - 48, width: fitted.width, height: fitted.height });
      } catch {
        cursor.page.drawText("Signature enregistrée", { x: 435, y: cursor.y - 31, size: 7, font: cursor.regular, color: MUTED });
      }
    }
    cursor.y -= 63;
  }

  ensure(cursor, 64);
  cursor.page.drawRectangle({ x: 42, y: cursor.y - 48, width: 511, height: 48, color: rgb(1, 0.97, 0.86), borderColor: rgb(0.9, 0.78, 0.35), borderWidth: 0.7 });
  drawLines(cursor.page, wrap("DOCUMENT DÉFINITIF FIGÉ — Toute correction ultérieure doit faire l’objet d’une nouvelle version. Le document signé d’origine reste conservé sans modification.", cursor.bold, 8, 480), 56, cursor.y - 17, cursor.bold, 8, NAVY, 11);

  addFooters(cursor, snapshot.trainee.public_ref, snapshot.trainee.record_version);
  return doc.save({ useObjectStreams: true });
}

function drawHeader(cursor: Cursor, title: string): void {
  const { page, bold, regular } = cursor;
  page.drawRectangle({ x: 0, y: A4[1] - 94, width: A4[0], height: 94, color: NAVY });
  page.drawRectangle({ x: 0, y: A4[1] - 99, width: A4[0], height: 5, color: CYAN });
  page.drawRectangle({ x: 42, y: A4[1] - 70, width: 38, height: 38, color: CYAN });
  page.drawText("G", { x: 53.5, y: A4[1] - 59, size: 20, font: bold, color: rgb(1, 1, 1) });
  page.drawText("GROUPEMENT HOSPITALIER EST", { x: 94, y: A4[1] - 43, size: 9.5, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Encadrement du brancardage", { x: 94, y: A4[1] - 58, size: 8, font: regular, color: rgb(0.78, 0.87, 0.91) });
  page.drawText(title, { x: 42, y: A4[1] - 84, size: 13, font: bold, color: rgb(1, 1, 1) });
  cursor.y = A4[1] - 124;
}

function newPage(cursor: Cursor): void {
  cursor.page = cursor.doc.addPage(A4);
  cursor.pages.push(cursor.page);
  cursor.page.drawRectangle({ x: 0, y: A4[1] - 42, width: A4[0], height: 42, color: NAVY });
  cursor.page.drawRectangle({ x: 0, y: A4[1] - 46, width: A4[0], height: 4, color: CYAN });
  cursor.page.drawText("GHE · SUIVI DE STAGE", { x: 42, y: A4[1] - 27, size: 9, font: cursor.bold, color: rgb(1, 1, 1) });
  cursor.y = A4[1] - 70;
}

function ensure(cursor: Cursor, height: number): void {
  if (cursor.y - height < 52) newPage(cursor);
}

function section(cursor: Cursor, label: string): void {
  ensure(cursor, 36);
  cursor.y -= 10;
  cursor.page.drawText(clean(label), { x: 42, y: cursor.y - 13, size: 9, font: cursor.bold, color: NAVY });
  cursor.page.drawRectangle({ x: 42, y: cursor.y - 18, width: 511, height: 2.2, color: CYAN });
  cursor.y -= 29;
}

function infoGrid(cursor: Cursor, rows: string[][]): void {
  const columnWidth = 255.5;
  for (let index = 0; index < rows.length; index += 2) {
    ensure(cursor, 47);
    for (let column = 0; column < 2; column += 1) {
      const row = rows[index + column];
      if (!row) continue;
      const x = 42 + column * columnWidth;
      cursor.page.drawRectangle({ x, y: cursor.y - 39, width: columnWidth - 5, height: 39, color: PALE, borderColor: LINE, borderWidth: 0.5 });
      cursor.page.drawText(clean(row[0] || ""), { x: x + 9, y: cursor.y - 13, size: 6.8, font: cursor.bold, color: MUTED });
      cursor.page.drawText(clean(row[1] || ""), { x: x + 9, y: cursor.y - 29, size: 9, font: cursor.regular, color: INK });
    }
    cursor.y -= 44;
  }
}

function labeledParagraph(cursor: Cursor, label: string, value: string): void {
  if (!value) return;
  const lines = wrap(clean(value), cursor.regular, 8.5, 497);
  const height = 26 + lines.length * 11;
  ensure(cursor, Math.min(height, 160));
  cursor.page.drawText(clean(label), { x: 47, y: cursor.y - 13, size: 8, font: cursor.bold, color: NAVY });
  cursor.y -= 22;
  paragraph(cursor, value);
}

function paragraph(cursor: Cursor, value: string, muted = false): void {
  let remaining = wrap(clean(value), cursor.regular, 8.5, 497);
  while (remaining.length) {
    const available = Math.max(1, Math.floor((cursor.y - 55) / 11));
    if (available < 2) { newPage(cursor); continue; }
    const chunk = remaining.splice(0, available);
    drawLines(cursor.page, chunk, 47, cursor.y - 10, cursor.regular, 8.5, muted ? MUTED : INK, 11);
    cursor.y -= chunk.length * 11 + 7;
    if (remaining.length) newPage(cursor);
  }
}

function drawLines(page: PDFPage, lines: string[], x: number, y: number, font: PDFFont, size: number, color: ReturnType<typeof rgb>, lineHeight: number): void {
  lines.forEach((line, index) => page.drawText(line, { x, y: y - index * lineHeight, size, font, color }));
}

function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const paragraphs = value.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function addFooters(cursor: Cursor, reference: string, version: number): void {
  cursor.pages.forEach((page, index) => {
    page.drawLine({ start: { x: 42, y: 35 }, end: { x: 553, y: 35 }, color: LINE, thickness: 0.6 });
    page.drawText(clean(`${reference} · version ${version} · document définitif`), { x: 42, y: 22, size: 6.8, font: cursor.regular, color: MUTED });
    page.drawText(`${index + 1} / ${cursor.pages.length}`, { x: 520, y: 22, size: 6.8, font: cursor.regular, color: MUTED });
  });
}

function ratingText(value: unknown): string {
  if (value === "NA") return "Éléments insuffisants";
  return ({ 1: "À acquérir", 2: "En cours", 3: "Acquis", 4: "Maîtrisé" } as Record<number, string>)[Number(value)] || "Non renseigné";
}

function roleLabel(role: string): string {
  return ({ ADMIN: "Administrateur", CHEF: "Responsable", AGENT: "Agent accompagnant", TUTOR: "Tuteur référent", TRAINEE: "Stagiaire" } as Record<string, string>)[role] || role;
}

function scopeLabel(scope: string): string {
  return ({ OBSERVATION: "témoignage personnel", SELF_SECTION: "expression du stagiaire", FINAL_EVALUATION: "évaluation finale" } as Record<string, string>)[scope] || scope;
}

function formatDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function formatDateTime(value: string): string {
  try { return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(value)); }
  catch { return value; }
}

function clean(value: string): string {
  return String(value || "")
    .replace(/œ/g, "oe").replace(/Œ/g, "OE")
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "");
}
