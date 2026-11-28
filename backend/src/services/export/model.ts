// ===========================================================================
// THE EXPORT DOCUMENT (M4.5 Wave 4) — the one shape every report and every export is built from.
//
// A report definition produces a ReportDocument from the AUTHORITATIVE backend services (the
// Module 13 engine, the sale / stock / AP / AR / payroll services, the platform registry). The
// SAME document is what the report screen shows and what the .xlsx, .csv and .pdf writers render,
// so an export is exactly the filtered view — never a second query that could disagree.
//
// Money is BigInt KES cents everywhere in the document; a writer converts it for display only.
// Quantities are decimal strings. Business dates are Africa/Nairobi days ("YYYY-MM-DD");
// instants are Dates and are shown in Africa/Nairobi time.
// ===========================================================================

import { PRODUCT_NAME } from "../../config/brand";

export type ColumnKind = "text" | "money" | "quantity" | "integer" | "percent" | "date" | "datetime";

export interface Column {
  key: string;
  header: string;
  kind: ColumnKind;
  /** Characters; a writer picks a sensible default by kind. */
  width?: number;
  /** Summed in the section's totals row (money, quantity and integer columns only). */
  total?: boolean;
}

/** One cell: cents for money, a decimal string for a quantity / percent, "YYYY-MM-DD" for a date. */
export type CellValue = string | number | bigint | Date | null;
export type Row = Readonly<Record<string, CellValue>>;

export interface Section {
  /** The sheet name in a workbook (≤ 31 characters; a writer truncates and de-duplicates). */
  name: string;
  columns: readonly Column[];
  rows: readonly Row[];
  /** A short note printed under the section (e.g. what the figures are based on). */
  note?: string;
}

export interface Brand {
  /** Shown at the top of every page and sheet: "Angaza360", or the business's own name. */
  name: string;
  /** "#RRGGBB" — the header colour. */
  color: string;
  /** A line under the name: the business's KRA PIN, address… */
  detail?: string;
}

export interface AppliedFilter {
  label: string;
  value: string;
}

export interface ReportDocument {
  reportId: string;
  title: string;
  brand: Brand;
  /** Every filter that shaped the rows, in words — printed on every export. */
  filters: readonly AppliedFilter[];
  /** The explicit period, when the report has one. */
  period: { from: string; to: string } | null;
  generatedAt: Date;
  sections: readonly Section[];
}

export const ANGAZA_BRAND: Brand = { name: PRODUCT_NAME, color: "#006078", detail: "Platform report" };

/** Rows across every section — what decides a streamed export from a background one. */
export function rowCount(document: ReportDocument): number {
  return document.sections.reduce((sum, section) => sum + section.rows.length, 0);
}
