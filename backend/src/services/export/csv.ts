// ===========================================================================
// CSV writer (M4.5 W4). RFC 4180: comma-separated, CRLF line ends, a field quoted when it holds a
// comma, a quote or a line break, a quote doubled. UTF-8 with a BOM so a spreadsheet opens
// "Wanjiru’s Duka" correctly. Every text cell goes through sanitizeText (formula injection).
//
// A CSV is one table, so a multi-section document is written section after section, each under a
// title line, with the report's header block (title, filters, period, generated at) on top —
// the same information as the workbook, in the one format a CSV allows.
// ===========================================================================

import type { ReportDocument } from "./model";
import { cellText, columnTotal, nairobiDateTime, sanitizeText } from "./values";

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const line = (cells: readonly string[]) => cells.map(field).join(",");

export function writeCsv(document: ReportDocument): Buffer {
  const lines: string[] = [];
  lines.push(line([sanitizeText(`${document.brand.name} — ${document.title}`)]));
  if (document.period) lines.push(line(["Period", `${document.period.from} to ${document.period.to}`]));
  for (const filter of document.filters) lines.push(line([sanitizeText(filter.label), sanitizeText(filter.value)]));
  lines.push(line(["Generated", `${nairobiDateTime(document.generatedAt)} (Africa/Nairobi)`]));
  lines.push(line(["Amounts", "KES"]));
  for (const section of document.sections) {
    lines.push("");
    if (document.sections.length > 1) lines.push(line([sanitizeText(section.name)]));
    lines.push(line(section.columns.map((column) => sanitizeText(column.header))));
    for (const row of section.rows) lines.push(line(section.columns.map((column) => cellText(column, row[column.key] ?? null, "csv"))));
    if (section.columns.some((column) => column.total)) {
      lines.push(
        line(section.columns.map((column, index) => (column.total ? columnTotal(column, section.rows.map((row) => row[column.key] ?? null)).text : index === 0 ? "Total" : ""))),
      );
    }
    if (section.note) lines.push(line([sanitizeText(section.note)]));
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8")]);
}
