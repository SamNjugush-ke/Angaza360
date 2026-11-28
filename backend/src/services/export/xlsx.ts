// ===========================================================================
// .xlsx writer (M4.5 W4) — a genuine Office Open XML workbook through ExcelJS.
//
// Each section is its own sheet. Every sheet opens with the report's header block — the brand,
// the title, the period, every applied filter and the generation time (Africa/Nairobi) — then a
// styled, frozen, filterable table: proper headers, column widths by kind, Arial throughout.
//   * money   -> a number with the KES format  #,##0.00;(#,##0.00);"-"  (negatives in brackets,
//               zero as a dash), from the cents' exact decimal string;
//   * dates   -> real Excel dates; instants converted to Nairobi wall time first;
//   * text    -> sanitized against formula injection (values.ts).
// TOTALS ARE FORMULAS: a totals row carries =SUM(…) over the column, with the BigInt total as the
// cached result, so the file reads correctly before Excel recalculates and recalculates if a
// figure is edited.
// ===========================================================================

import ExcelJS from "exceljs";
import { businessDateTimeParts } from "../../lib/business-time";
import { formatCents } from "../../lib/money";
import type { CellValue, Column, ReportDocument } from "./model";
import { columnTotal, nairobiDateTime, sanitizeText } from "./values";

const FONT = "Arial";
export const MONEY_FORMAT = '#,##0.00;(#,##0.00);"-"';
const QUANTITY_FORMAT = "#,##0.###";
const INTEGER_FORMAT = "#,##0";
const PERCENT_FORMAT = "0.00%";
const DATE_FORMAT = "dd mmm yyyy";
const DATETIME_FORMAT = "dd mmm yyyy hh:mm";

const DEFAULT_WIDTH: Record<Column["kind"], number> = { text: 28, money: 16, quantity: 12, integer: 10, percent: 10, date: 13, datetime: 18 };

function argb(hex: string): string {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : "006078";
  return `FF${clean.toUpperCase()}`;
}

/** A presentation-only number from exact cents (never arithmetic on it). */
function centsNumber(cents: bigint): number {
  return Number(formatCents(cents));
}

/** The instant as a Date whose UTC fields read the Nairobi wall clock (Excel has no zones). */
function nairobiWall(instant: Date): Date {
  const p = businessDateTimeParts(instant);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

function cellValue(column: Column, value: CellValue): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  switch (column.kind) {
    case "money":
      return typeof value === "bigint" ? centsNumber(value) : /^-?\d+$/.test(String(value)) ? centsNumber(BigInt(String(value))) : sanitizeText(String(value));
    case "integer":
      return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : sanitizeText(String(value));
    case "quantity":
      return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : sanitizeText(String(value));
    case "percent":
      return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) / 100 : sanitizeText(String(value));
    case "date":
      if (value instanceof Date) return value;
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${String(value)}T00:00:00.000Z`) : sanitizeText(String(value));
    case "datetime":
      return value instanceof Date ? nairobiWall(value) : sanitizeText(String(value));
    case "text":
    default:
      return sanitizeText(value instanceof Date ? nairobiDateTime(value) : String(value));
  }
}

const NUM_FMT: Record<Column["kind"], string | undefined> = {
  text: undefined,
  money: MONEY_FORMAT,
  quantity: QUANTITY_FORMAT,
  integer: INTEGER_FORMAT,
  percent: PERCENT_FORMAT,
  date: DATE_FORMAT,
  datetime: DATETIME_FORMAT,
};

/** Excel's limits: ≤ 31 characters, none of []:*?/\, unique in the workbook. */
function sheetName(name: string, taken: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${base.slice(0, 27)} (${n.toString()})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export async function writeXlsx(document: ReportDocument): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = document.brand.name;
  workbook.title = document.title;
  workbook.created = document.generatedAt;
  const taken = new Set<string>();
  const brand = argb(document.brand.color);

  for (const section of document.sections) {
    const sheet = workbook.addWorksheet(sheetName(section.name, taken));
    const span = Math.max(section.columns.length, 2);

    const header: Array<[string, string]> = [];
    if (document.period) header.push(["Period", `${document.period.from} to ${document.period.to}`]);
    for (const filter of document.filters) header.push([filter.label, filter.value]);
    header.push(["Generated", `${nairobiDateTime(document.generatedAt)} (Africa/Nairobi)`]);
    header.push(["Amounts", "Kenya shillings (KES)"]);

    const brandRow = sheet.addRow([sanitizeText(document.brand.name)]);
    sheet.mergeCells(brandRow.number, 1, brandRow.number, span);
    brandRow.font = { name: FONT, bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    brandRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: brand } };
    if (document.brand.detail) sheet.addRow([sanitizeText(document.brand.detail)]).font = { name: FONT, size: 10, color: { argb: "FF555555" } };
    const titleRow = sheet.addRow([sanitizeText(document.sections.length > 1 ? `${document.title} — ${section.name}` : document.title)]);
    titleRow.font = { name: FONT, bold: true, size: 12 };
    for (const [label, value] of header) {
      const row = sheet.addRow([sanitizeText(label), sanitizeText(value)]);
      row.getCell(1).font = { name: FONT, bold: true, size: 10 };
      row.getCell(2).font = { name: FONT, size: 10 };
    }
    sheet.addRow([]);

    const headerRow = sheet.addRow(section.columns.map((column) => sanitizeText(column.header)));
    headerRow.eachCell((cell) => {
      cell.font = { name: FONT, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: brand } };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    const firstData = headerRow.number + 1;
    section.columns.forEach((column, index) => {
      const col = sheet.getColumn(index + 1);
      col.width = column.width ?? DEFAULT_WIDTH[column.kind];
      if (column.kind !== "text") headerRow.getCell(index + 1).alignment = { horizontal: "right", vertical: "middle", wrapText: true };
    });

    for (const row of section.rows) {
      const added = sheet.addRow(section.columns.map((column) => cellValue(column, row[column.key] ?? null)));
      section.columns.forEach((column, index) => {
        const cell = added.getCell(index + 1);
        cell.font = { name: FONT, size: 10 };
        const format = NUM_FMT[column.kind];
        if (format) cell.numFmt = format;
      });
    }
    const lastData = firstData + section.rows.length - 1;

    if (section.columns.some((column) => column.total)) {
      const totals = sheet.addRow(section.columns.map(() => null));
      totals.getCell(1).value = "Total";
      section.columns.forEach((column, index) => {
        const cell = totals.getCell(index + 1);
        cell.font = { name: FONT, bold: true, size: 10 };
        cell.border = { top: { style: "thin" }, bottom: { style: "double" } };
        if (!column.total) return;
        const letter = sheet.getColumn(index + 1).letter;
        const total = columnTotal(column, section.rows.map((r) => r[column.key] ?? null));
        const result = total.cents !== undefined ? (column.kind === "money" ? centsNumber(total.cents) : Number(total.cents)) : Number(total.text || "0");
        cell.value = section.rows.length === 0 ? 0 : { formula: `SUM(${letter}${firstData.toString()}:${letter}${lastData.toString()})`, result };
        const format = NUM_FMT[column.kind];
        if (format) cell.numFmt = format;
      });
    }
    if (section.note) {
      sheet.addRow([]);
      sheet.addRow([sanitizeText(section.note)]).font = { name: FONT, italic: true, size: 9, color: { argb: "FF555555" } };
    }

    sheet.views = [{ state: "frozen", ySplit: headerRow.number }];
    if (section.rows.length > 0) sheet.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: lastData, column: section.columns.length } };
    sheet.pageSetup = { orientation: section.columns.length > 6 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow.number.toString()}:${headerRow.number.toString()}` };
    sheet.headerFooter = { oddFooter: `&L${sanitizeText(document.brand.name).replace(/&/g, "&&")}&RPage &P of &N` };
  }
  if (document.sections.length === 0) workbook.addWorksheet("Report").addRow(["No data"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
