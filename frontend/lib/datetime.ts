// Business dates for the Angaza360 frontend.
//
// The accounting day is cut in Africa/Nairobi, never in UTC and never in the browser's own zone
// (the engineering ledger, "Timestamps & Reporting Dates"). Every instant becomes a business day through
// Intl with an explicit timeZone, so a user on a laptop set to another zone still sees the
// Nairobi day. A business date is a plain 'YYYY-MM-DD' string: a calendar day, not an instant.

export const BUSINESS_TZ = "Africa/Nairobi";

/** A calendar day, 'YYYY-MM-DD'. */
export type BusinessDate = string;

export interface Period {
  from: BusinessDate;
  to: BusinessDate;
}

export type DateStyle = "short" | "medium" | "weekday";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const businessDayParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function isValidDateOnly(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function toInstant(value: Date | string): Date {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError(`Not a date: "${String(value)}"`);
  }
  return instant;
}

/**
 * The Nairobi business day of an instant. A 'YYYY-MM-DD' string is already a business date and
 * is returned unchanged (it is a calendar day, not midnight UTC).
 */
export function toBusinessDate(value: Date | string): BusinessDate {
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    if (!isValidDateOnly(value)) throw new TypeError(`Not a date: "${value}"`);
    return value;
  }
  const parts = businessDayParts.formatToParts(toInstant(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Today in Africa/Nairobi. `now` is injectable for tests. */
export function businessToday(now: Date = new Date()): BusinessDate {
  return toBusinessDate(now);
}

const formatters: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { day: "2-digit", month: "2-digit", year: "numeric" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  weekday: { weekday: "short", day: "numeric", month: "short", year: "numeric" },
};

/**
 * en-KE display: short "20/10/2026", medium "20 Oct 2026", weekday "Tue 20 Oct 2026".
 * A 'YYYY-MM-DD' business date is shown as that day; an instant is shown as its Nairobi day.
 */
export function formatDate(value: Date | string, style: DateStyle = "medium"): string {
  const day = toBusinessDate(value);
  const [y, m, d] = day.split("-").map(Number);
  // Format the calendar day itself, at noon UTC so no zone can move it.
  const formatter = new Intl.DateTimeFormat("en-KE", { ...formatters[style], timeZone: "UTC" });
  const parts = formatter.formatToParts(new Date(Date.UTC(y, m - 1, d, 12)));
  // ICU puts a comma after the weekday ("Tue, 20 Oct 2026"); the product style has none.
  return parts.map((p) => (p.type === "literal" ? p.value.replace(",", "") : p.value)).join("");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The same calendar day one month earlier, clamped to that month's last day (31 Mar → 28 Feb). */
function previousMonthSameDay(date: BusinessDate): BusinessDate {
  const [y, m, d] = toBusinessDate(date).split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  return `${year}-${pad2(month)}-${pad2(Math.min(d, daysInMonth(year, month)))}`;
}

/** First of the month through the reference day, both as Nairobi business dates. */
export function monthToDate(ref: Date | string = new Date()): Period {
  const to = toBusinessDate(ref);
  return { from: `${to.slice(0, 8)}01`, to };
}

/**
 * The SAME span one month earlier — 1–20 Oct compares with 1–20 Sep, not the whole of September.
 * A day the prior month lacks is clamped to its last day (1–31 Mar → 1–28 Feb).
 */
export function equivalentPriorPeriod(period: Period): Period {
  const from = toBusinessDate(period.from);
  const to = toBusinessDate(period.to);
  if (from > to) throw new RangeError(`Period starts after it ends: ${from} > ${to}`);
  return { from: previousMonthSameDay(from), to: previousMonthSameDay(to) };
}

/** What kind of period a range is — it decides what a fair comparison is. */
export type PeriodKind = "month-to-date" | "month" | "year-to-date" | "custom";

export interface Comparison {
  period: Period;
  /** What the change is measured against, in words: "last month", "last year"… */
  label: string;
}

const MS_PER_DAY = 86_400_000;

function dayNumber(date: BusinessDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function addDays(date: BusinessDate, days: number): BusinessDate {
  return new Date((dayNumber(date) + days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The same calendar day one year earlier, 29 Feb clamped to 28 Feb. */
function previousYearSameDay(date: BusinessDate): BusinessDate {
  const [y, m, d] = date.split("-").map(Number);
  return `${y - 1}-${pad2(m)}-${pad2(Math.min(d, daysInMonth(y - 1, m)))}`;
}

/**
 * "THE PERIOD BEFORE" — ONE convention, shared with every Module 13 statement (M4.5 W3; the
 * backend's `comparativePeriodOf` in services/reports.ts states the same rules). Decided by the
 * SHAPE of the period, so the dashboard and the income statement can never disagree:
 *   * a whole month          -> the whole month before (September vs August);
 *   * a whole year           -> the year before;
 *   * month to date (1st..D) -> the SAME DAYS of the month before (1–20 Oct vs 1–20 Sep), clamped;
 *   * year to date (1 Jan..D)-> the same days of the year before;
 *   * any other span         -> the immediately preceding span of equal length.
 * `kind` only words the label ("last month", "last year"…).
 */
export function comparisonPeriodOf(period: Period, kind: PeriodKind): Comparison {
  const from = toBusinessDate(period.from);
  const to = toBusinessDate(period.to);
  if (from > to) throw new RangeError(`Period starts after it ends: ${from} > ${to}`);
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const wholeMonth = fd === 1 && fy === ty && fm === tm && td === daysInMonth(ty, tm);
  const wholeYear = fd === 1 && fm === 1 && fy === ty && tm === 12 && td === 31;
  const label = kind === "month-to-date" ? "last month" : kind === "month" ? "previous month" : kind === "year-to-date" ? "last year" : "previous period";
  if (wholeYear) return { period: { from: `${fy - 1}-01-01`, to: `${fy - 1}-12-31` }, label };
  if (wholeMonth) {
    const prior = previousMonthSameDay(from);
    const [y, m] = prior.split("-").map(Number);
    return { period: { from: `${prior.slice(0, 8)}01`, to: `${prior.slice(0, 8)}${pad2(daysInMonth(y, m))}` }, label };
  }
  if (fd === 1 && fy === ty && fm === tm) return { period: equivalentPriorPeriod({ from, to }), label };
  if (fd === 1 && fm === 1 && fy === ty) return { period: { from: previousYearSameDay(from), to: previousYearSameDay(to) }, label };
  const length = dayNumber(to) - dayNumber(from) + 1;
  const end = addDays(from, -1);
  return { period: { from: addDays(end, -(length - 1)), to: end }, label };
}

/**
 * Percentage change from baseline to current, to 2 decimals (half away from zero), computed in
 * BigInt. null when the baseline is zero or negative: a change against nothing, or against a
 * loss, has no meaningful percentage or sign, and the UI shows "—". The result is a ratio, not
 * money, so returning a number is safe.
 */
export function pctDelta(current: bigint, baseline: bigint): number | null {
  if (baseline <= 0n) return null;
  const numerator = (current - baseline) * 10_000n; // basis points × baseline
  const magnitude = numerator < 0n ? -numerator : numerator;
  const basisPoints = (2n * magnitude + baseline) / (2n * baseline);
  const signed = numerator < 0n ? -basisPoints : basisPoints;
  return Number(signed) / 100;
}

const timeFormatter = new Intl.DateTimeFormat("en-KE", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: BUSINESS_TZ });

/** An instant's wall-clock time in Nairobi, 24-hour: "09:30". */
export function formatTime(value: Date | string): string {
  return timeFormatter.format(typeof value === "string" ? new Date(value) : value);
}

/** An instant as its Nairobi day and time: "5 Nov 2026 09:30". */
export function formatDateTime(value: Date | string): string {
  return `${formatDate(value)} ${formatTime(value)}`;
}
