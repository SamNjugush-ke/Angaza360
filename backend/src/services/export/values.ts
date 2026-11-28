// ===========================================================================
// How an export cell is written (M4.5 W4) — shared by the .xlsx, .csv and .pdf writers.
//
// FORMULA-INJECTION SAFE: any TEXT cell that begins with = + - @ (or a tab / carriage return,
// which some spreadsheet programs strip before evaluating) is prefixed with an apostrophe, so a
// product, customer or business name like `=HYPERLINK("http://evil")` is stored and shown as
// text, never run as a formula (OWASP "CSV Injection"). Numbers, money and dates are written as
// typed values and are not text, so they are never affected.
//
// Money stays BigInt cents until the very last step. A spreadsheet stores numbers as doubles, so
// the workbook gets the amount parsed from its exact decimal string (formatCents) — a
// presentation conversion only; every total is summed in BigInt (and, in a workbook, by a SUM
// formula whose cached value is that BigInt total).
// ===========================================================================

import { businessDateTimeParts } from "../../lib/business-time";
import { formatCents } from "../../lib/money";
import type { CellValue, Column } from "./model";

const DANGEROUS = /^[=+\-@\t\r]/;

/** Neutralises a text cell that a spreadsheet would read as a formula. */
export function sanitizeText(value: string): string {
  return DANGEROUS.test(value) ? `'${value}` : value;
}

const pad = (n: number, width = 2) => n.toString().padStart(width, "0");

/** An instant as Africa/Nairobi wall time: "2026-11-17 08:30". */
export function nairobiDateTime(instant: Date): string {
  const p = businessDateTimeParts(instant);
  return `${p.year.toString()}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "2026-11-17" (a business date stored as 00:00 UTC of that day). */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 1234567n -> "12,345.67" (grouped; sign kept). */
export function groupedCents(cents: bigint): string {
  const plain = formatCents(cents);
  const negative = plain.startsWith("-");
  const unsigned = negative ? plain.slice(1) : plain;
  const [whole = "0", fraction = "00"] = unsigned.split(".");
  return `${negative ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function asCents(value: CellValue): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * A cell as TEXT, for a CSV or a PDF: money "1234.56" (CSV) or "1,234.56" (PDF), a business date
 * as-is, an instant in Nairobi time, text sanitized.
 */
export function cellText(column: Column, value: CellValue, style: "csv" | "pdf"): string {
  if (value === null || value === undefined) return "";
  switch (column.kind) {
    case "money": {
      const cents = asCents(value);
      if (cents === null) return sanitizeText(String(value));
      return style === "csv" ? formatCents(cents) : groupedCents(cents);
    }
    case "datetime":
      return value instanceof Date ? nairobiDateTime(value) : sanitizeText(String(value));
    case "date":
      return value instanceof Date ? isoDay(value) : sanitizeText(String(value));
    case "integer":
      return typeof value === "bigint" ? value.toString() : sanitizeText(String(value));
    case "quantity":
    case "percent":
      return sanitizeText(String(value));
    case "text":
    default:
      return sanitizeText(value instanceof Date ? nairobiDateTime(value) : String(value));
  }
}

/** The BigInt total of a money / integer column, or the exact total of a quantity column (milli). */
export function columnTotal(column: Column, values: readonly CellValue[]): { cents?: bigint; text: string } {
  if (column.kind === "money" || column.kind === "integer") {
    const sum = values.reduce<bigint>((acc, value) => acc + (asCents(value) ?? 0n), 0n);
    return column.kind === "money" ? { cents: sum, text: formatCents(sum) } : { cents: sum, text: sum.toString() };
  }
  if (column.kind === "quantity") {
    let milli = 0n;
    for (const value of values) {
      if (typeof value !== "string" || !/^-?\d+(\.\d{1,3})?$/.test(value)) continue;
      const negative = value.startsWith("-");
      const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
      const amount = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
      milli += negative ? -amount : amount;
    }
    const negative = milli < 0n;
    const magnitude = negative ? -milli : milli;
    return { text: `${negative ? "-" : ""}${(magnitude / 1000n).toString()}.${(magnitude % 1000n).toString().padStart(3, "0")}` };
  }
  return { text: "" };
}

/** "Nakuru Hardware" + "Sales" + period -> "nakuru-hardware-sales-2026-11-01_2026-11-17-202611170830". */
export function exportFilename(brandName: string, reportId: string, period: { from: string; to: string } | null, at: Date, extension: string): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "report";
  const p = businessDateTimeParts(at);
  const stamp = `${p.year.toString()}${pad(p.month)}${pad(p.day)}${pad(p.hour)}${pad(p.minute)}`;
  const span = period ? `-${period.from}_${period.to}` : "";
  return `${slug(brandName)}-${slug(reportId)}${span}-${stamp}.${extension}`;
}
