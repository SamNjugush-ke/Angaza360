// ===========================================================================
// PDF writer (M4.5 W4) — a branded, paginated document through pdfkit.
//
// Every page carries the brand band (Angaza360 for a platform report, the business's own name and
// colour for its own documents), and every page ends with the generation time and "Page n of N".
// Page one adds the title, the period and every applied filter. Each section is a table whose
// header row repeats on every page it spans; money is right-aligned and grouped ("12,345.67");
// a totals row closes the table. A4, landscape when the table is wide.
//
// The built-in Helvetica speaks WinAnsi only, so any character it cannot draw is written as "?"
// rather than as a broken glyph (the pdf skill's warning about missing glyphs).
// ===========================================================================

import PDFDocument from "pdfkit";
import type { Column, ReportDocument, Section } from "./model";
import { cellText, columnTotal, groupedCents, nairobiDateTime } from "./values";

const MARGIN = 36;
const ROW_HEIGHT = 16;
const BAND_HEIGHT = 34;
const FOOTER_SPACE = 28;

// WinAnsi extras beyond Latin-1 that Helvetica can draw.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

function drawable(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    out += (code >= 32 && code <= 255 && !(code >= 127 && code < 160)) || WIN_ANSI_EXTRA.has(ch) ? ch : "?";
  }
  return out;
}

const WEIGHT: Record<Column["kind"], number> = { text: 3, money: 1.6, quantity: 1.1, integer: 0.9, percent: 0.9, date: 1.2, datetime: 1.7 };

function widths(columns: readonly Column[], usable: number): number[] {
  const weights = columns.map((column) => column.width !== undefined ? column.width / 10 : WEIGHT[column.kind]);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => (w / sum) * usable);
}

const rightAligned = (column: Column) => column.kind !== "text";

export async function writePdf(document: ReportDocument): Promise<Buffer> {
  const wide = document.sections.some((section) => section.columns.length > 6);
  const doc = new PDFDocument({
    size: "A4",
    layout: wide ? "landscape" : "portrait",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: drawable(document.title), Author: drawable(document.brand.name), Creator: drawable(document.brand.name) },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on("end", () => resolve()));

  const pageWidth = doc.page.width;
  const usable = pageWidth - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN - FOOTER_SPACE;

  const band = () => {
    doc.save();
    doc.rect(0, 0, pageWidth, BAND_HEIGHT).fill(/^#[0-9a-fA-F]{6}$/.test(document.brand.color) ? document.brand.color : "#006078");
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(13).text(drawable(document.brand.name), MARGIN, 11, { width: usable * 0.6, lineBreak: false, ellipsis: true });
    if (document.brand.detail) doc.font("Helvetica").fontSize(8).text(drawable(document.brand.detail), MARGIN + usable * 0.6, 14, { width: usable * 0.4, align: "right", lineBreak: false, ellipsis: true });
    doc.restore();
    doc.fillColor("#0F172A");
    doc.y = BAND_HEIGHT + 14;
  };

  band();
  doc.font("Helvetica-Bold").fontSize(16).text(drawable(document.title), MARGIN, doc.y, { width: usable });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(9).fillColor("#334155");
  const facts = [
    ...(document.period ? [`Period: ${document.period.from} to ${document.period.to}`] : []),
    ...document.filters.map((filter) => `${filter.label}: ${filter.value}`),
    "Amounts in Kenya shillings (KES)",
  ];
  for (const fact of facts) doc.text(drawable(fact), MARGIN, doc.y, { width: usable });
  doc.fillColor("#0F172A");
  doc.moveDown(0.8);

  const newPage = () => {
    doc.addPage();
    band();
  };

  const drawRow = (section: Section, cells: readonly string[], cols: number[], opts: { header?: boolean; bold?: boolean }) => {
    if (doc.y + ROW_HEIGHT > bottom()) {
      newPage();
      if (!opts.header) drawHeader(section, cols);
    }
    const y = doc.y;
    if (opts.header) {
      doc.save().rect(MARGIN, y - 3, usable, ROW_HEIGHT).fill("#E2E8F0").restore();
    }
    doc.font(opts.header || opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor("#0F172A");
    let x = MARGIN;
    section.columns.forEach((column, index) => {
      const width = cols[index] ?? 40;
      doc.text(drawable(cells[index] ?? ""), x + 2, y, { width: width - 4, align: rightAligned(column) ? "right" : "left", lineBreak: false, ellipsis: true });
      x += width;
    });
    if (opts.bold) doc.moveTo(MARGIN, y - 3).lineTo(MARGIN + usable, y - 3).lineWidth(0.5).stroke("#0F172A");
    doc.y = y + ROW_HEIGHT;
  };

  const drawHeader = (section: Section, cols: number[]) => drawRow(section, section.columns.map((c) => c.header), cols, { header: true });

  document.sections.forEach((section) => {
    const cols = widths(section.columns, usable);
    if (doc.y + ROW_HEIGHT * 3 > bottom()) newPage();
    if (document.sections.length > 1) {
      doc.font("Helvetica-Bold").fontSize(11).text(drawable(section.name), MARGIN, doc.y, { width: usable });
      doc.moveDown(0.3);
    }
    drawHeader(section, cols);
    if (section.rows.length === 0) {
      doc.font("Helvetica-Oblique").fontSize(8).text("No rows for these filters.", MARGIN + 2, doc.y, { width: usable });
      doc.moveDown(0.5);
    }
    for (const row of section.rows) {
      drawRow(section, section.columns.map((column) => cellText(column, row[column.key] ?? null, "pdf")), cols, {});
    }
    if (section.columns.some((column) => column.total)) {
      drawRow(
        section,
        section.columns.map((column, index) => {
          if (!column.total) return index === 0 ? "Total" : "";
          const total = columnTotal(column, section.rows.map((r) => r[column.key] ?? null));
          return column.kind === "money" && total.cents !== undefined ? groupedCents(total.cents) : total.text;
        }),
        cols,
        { bold: true },
      );
    }
    if (section.note) {
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#475569").text(drawable(section.note), MARGIN, doc.y + 2, { width: usable });
      doc.fillColor("#0F172A");
    }
    doc.moveDown(1);
  });

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const y = doc.page.height - MARGIN - 10;
    doc.font("Helvetica").fontSize(7).fillColor("#64748B");
    doc.text(drawable(`Generated ${nairobiDateTime(document.generatedAt)} (Africa/Nairobi)`), MARGIN, y, { width: usable / 2, lineBreak: false });
    doc.text(`Page ${(i - range.start + 1).toString()} of ${range.count.toString()}`, MARGIN + usable / 2, y, { width: usable / 2, align: "right", lineBreak: false });
  }
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}
