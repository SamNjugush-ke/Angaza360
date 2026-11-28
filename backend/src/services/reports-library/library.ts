// ===========================================================================
// THE CURATED REPORT LIBRARY (M4.5 Wave 4) — the core every report definition shares.
//
// NOT an arbitrary query builder: each report is a named definition with its own filters, its own
// roles and its own run(), built ONLY from the authoritative services (the Module 13 engine, the
// sale / stock / AP / AR / payroll services, the platform registry, the consented gates). Its
// output is a ReportDocument; the screen shows that document (paginated) and every export renders
// that same document, so the file is exactly the filtered view.
//
// SECURITY (brief §3.4): a tenant report runs on the SESSION's tenant client — there is no tenant
// parameter; a platform report is for platform staff only; each definition lists the roles the
// underlying API would admit, so a report never shows a role more than its screens do; periods
// are explicit (defaults are stated on the document); every run is bounded (MAX_ROWS) and a
// larger result asks the person to narrow the filters rather than truncating silently.
// ===========================================================================

import type { UserRole } from "../../generated/platform/client";
import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import { businessDayStart, businessToday } from "../../lib/business-time";
import type { AppliedFilter, Brand, CellValue, Column, ReportDocument, Section } from "../export/model";
import { columnTotal, isoDay } from "../export/values";

/** A section may hold at most this many rows; more asks the person to narrow the filters. */
export const MAX_ROWS = 50_000;

export class ReportFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportFilterError";
  }
}

export class ReportNotFoundError extends Error {
  constructor(message = "No such report.") {
    super(message);
    this.name = "ReportNotFoundError";
  }
}

export type FilterType = "date" | "select" | "search" | "entity" | "number";
export type EntityKind = "location" | "customer" | "supplier" | "product" | "payrollRun" | "tenant" | "donorProject" | "user";

export interface FilterSpec {
  key: string;
  label: string;
  type: FilterType;
  options?: ReadonlyArray<{ value: string; label: string }>;
  entity?: EntityKind;
  /** What the report uses when the filter is left empty — shown on the document. */
  defaultHint?: string;
  required?: boolean;
}

export type Category = "operations" | "financial" | "payroll" | "integrations" | "mentorship" | "platform" | "donor";

/** The raw query: every filter arrives as a string (or not at all). */
export type Query = Readonly<Record<string, string | undefined>>;

export interface TenantContext {
  db: TenantPrismaClient;
  tenantId: string;
  userId: string;
  role: UserRole;
  brand: Brand;
  /** The business's registered name, for documents that name the employer. */
  businessName: string;
}

export interface PlatformContext {
  userId: string;
  role: UserRole;
}

export interface ReportDefinition<C> {
  id: string;
  title: string;
  description: string;
  category: Category;
  roles: readonly UserRole[];
  /** Personal, payroll or identity data: exports are flagged sensitive in the audit log. */
  sensitive: boolean;
  filters: readonly FilterSpec[];
  run(context: C, query: Query): Promise<ReportDocument>;
}

export type TenantReport = ReportDefinition<TenantContext>;
export type PlatformReport = ReportDefinition<PlatformContext>;

// ---- Filter parsing (every report goes through these, so the rules are one) ----

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function dateFilter(query: Query, key: string, label: string): Date | undefined {
  const raw = query[key]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new ReportFilterError(`${label} must be a date (YYYY-MM-DD).`);
  return new Date(`${raw}T00:00:00.000Z`);
}

export function textFilter(query: Query, key: string, max = 100): string | undefined {
  const raw = query[key]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (raw.length > max) throw new ReportFilterError(`The ${key} filter is too long.`);
  return raw;
}

export function enumFilter<T extends string>(query: Query, key: string, label: string, values: readonly T[]): T | undefined {
  const raw = textFilter(query, key);
  if (raw === undefined) return undefined;
  if (!(values as readonly string[]).includes(raw)) throw new ReportFilterError(`${label} must be one of: ${values.join(", ")}.`);
  return raw as T;
}

export function intFilter(query: Query, key: string, label: string, min: number, max: number, fallback: number): number {
  const raw = textFilter(query, key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new ReportFilterError(`${label} must be a whole number from ${min.toString()} to ${max.toString()}.`);
  return Number(raw);
}

/**
 * An explicit period, from / to (business days, both inclusive). Left empty it is the current
 * month to date — and the document SAYS so, because the period is printed on every export.
 */
export function periodFilter(query: Query, maxDays = 1_100): { from: Date; to: Date } {
  const today = businessToday();
  const from = dateFilter(query, "from", "From") ?? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const to = dateFilter(query, "to", "To") ?? today;
  if (from > to) throw new ReportFilterError("The start date must be on or before the end date.");
  if ((to.getTime() - from.getTime()) / 86_400_000 > maxDays) throw new ReportFilterError(`Choose a period of at most ${maxDays.toString()} days.`);
  return { from, to };
}

export const periodOf = (p: { from: Date; to: Date }) => ({ from: isoDay(p.from), to: isoDay(p.to) });

/**
 * The INSTANTS a period of business days covers, for a record that has only a timestamp: from the
 * start of the first day to the start of the day after the last, both in Africa/Nairobi (the
 * business-time module is the only place a day is cut).
 */
export function businessWindow(p: { from: Date; to: Date }): { start: Date; endExclusive: Date } {
  const after = new Date(p.to.getTime() + 86_400_000);
  return {
    start: businessDayStart(p.from.getUTCFullYear(), p.from.getUTCMonth() + 1, p.from.getUTCDate()),
    endExclusive: businessDayStart(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate()),
  };
}

export const PERIOD_FILTERS: readonly FilterSpec[] = [
  { key: "from", label: "From", type: "date", defaultHint: "the 1st of this month" },
  { key: "to", label: "To", type: "date", defaultHint: "today" },
];

/** Builds the "applied filters" list in words, leaving out what was not set. */
export function applied(...entries: Array<[string, string | undefined | null]>): AppliedFilter[] {
  return entries.filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== null && entry[1] !== "").map(([label, value]) => ({ label, value }));
}

export function bounded<T>(rows: readonly T[], what: string): readonly T[] {
  if (rows.length > MAX_ROWS) {
    throw new ReportFilterError(`This would list ${rows.length.toString()} ${what}, more than the ${MAX_ROWS.toString()} a report can hold. Narrow the period or the filters.`);
  }
  return rows;
}

/** Case-insensitive "contains" for a search filter, over the given texts. */
export function matches(q: string | undefined, ...texts: Array<string | null | undefined>): boolean {
  if (q === undefined) return true;
  const needle = q.toLowerCase();
  return texts.some((text) => (text ?? "").toLowerCase().includes(needle));
}

export function doc(input: {
  reportId: string;
  title: string;
  brand: Brand;
  filters: readonly AppliedFilter[];
  period: { from: string; to: string } | null;
  sections: readonly Section[];
}): ReportDocument {
  return { ...input, generatedAt: new Date() };
}

// ---- The screen's view of a document: the same rows, paginated, as wire-safe strings ----

export interface ViewColumn {
  key: string;
  header: string;
  kind: Column["kind"];
  total: boolean;
}

export interface ViewSection {
  name: string;
  note: string | null;
  columns: ViewColumn[];
  totalRows: number;
  rows: Array<Record<string, string | null>>;
  totals: Record<string, string> | null;
}

export interface ReportView {
  reportId: string;
  title: string;
  brandName: string;
  filters: AppliedFilter[];
  period: { from: string; to: string } | null;
  generatedAt: Date;
  sections: ViewSection[];
}

/** One cell as the API sends it: money as a string of cents, a date "YYYY-MM-DD", an instant ISO. */
function wire(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function viewOf(document: ReportDocument, take: number, skip: number): ReportView {
  return {
    reportId: document.reportId,
    title: document.title,
    brandName: document.brand.name,
    filters: [...document.filters],
    period: document.period,
    generatedAt: document.generatedAt,
    sections: document.sections.map((section) => ({
      name: section.name,
      note: section.note ?? null,
      columns: section.columns.map((c) => ({ key: c.key, header: c.header, kind: c.kind, total: c.total === true })),
      totalRows: section.rows.length,
      rows: section.rows.slice(skip, skip + take).map((row) => Object.fromEntries(section.columns.map((c) => [c.key, wire(row[c.key] ?? null)]))),
      totals: section.columns.some((c) => c.total)
        ? Object.fromEntries(
            section.columns
              .filter((c) => c.total)
              .map((c) => {
                const t = columnTotal(c, section.rows.map((r) => r[c.key] ?? null));
                return [c.key, t.cents !== undefined ? t.cents.toString() : t.text];
              }),
          )
        : null,
    })),
  };
}

/** What the library lists for a role: the definition without its run(). */
export function catalogueOf<C>(reports: ReadonlyArray<ReportDefinition<C>>, role: UserRole) {
  return reports
    .filter((report) => report.roles.includes(role))
    .map((report) => ({ id: report.id, title: report.title, description: report.description, category: report.category, sensitive: report.sensitive, filters: report.filters.map((f) => ({ ...f, options: f.options ? [...f.options] : undefined })) }));
}

export function findReport<C>(reports: ReadonlyArray<ReportDefinition<C>>, id: string, role: UserRole): ReportDefinition<C> {
  const report = reports.find((r) => r.id === id);
  // A report the role may not run is "not found": the library does not confirm it exists.
  if (report === undefined || !report.roles.includes(role)) throw new ReportNotFoundError();
  return report;
}
