import { businessToday, formatDate, monthToDate, type BusinessDate, type Period, type PeriodKind } from "@/lib/datetime";

// The period selector's presets, each mapped to a {from, to} of Africa/Nairobi business days.

export type PeriodPreset = "month-to-date" | "last-month" | "year-to-date" | "custom";

export const PRESET_LABEL: Readonly<Record<PeriodPreset, string>> = {
  "month-to-date": "This month to date",
  "last-month": "Last month",
  "year-to-date": "This year to date",
  custom: "Custom range",
};

const pad2 = (n: number) => String(n).padStart(2, "0");

function lastMonth(today: BusinessDate): Period {
  const [y, m] = today.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad2(month)}-01`, to: `${year}-${pad2(month)}-${pad2(last)}` };
}

/** The period a preset means today. "custom" keeps whatever range is current. */
export function periodFor(preset: Exclude<PeriodPreset, "custom">, today: BusinessDate = businessToday()): Period {
  switch (preset) {
    case "month-to-date":
      return monthToDate(today);
    case "last-month":
      return lastMonth(today);
    case "year-to-date":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/** Which preset a period is, or "custom". */
export function presetOf(period: Period, today: BusinessDate = businessToday()): PeriodPreset {
  for (const preset of ["month-to-date", "last-month", "year-to-date"] as const) {
    const candidate = periodFor(preset, today);
    if (candidate.from === period.from && candidate.to === period.to) return preset;
  }
  return "custom";
}

const KIND_OF: Readonly<Record<PeriodPreset, PeriodKind>> = {
  "month-to-date": "month-to-date",
  "last-month": "month",
  "year-to-date": "year-to-date",
  custom: "custom",
};

/** The kind of a period — what it is fairly compared with — from the preset it matches. */
export function periodKindOf(period: Period, today: BusinessDate = businessToday()): PeriodKind {
  return KIND_OF[presetOf(period, today)];
}

/** "1 Oct 2026 – 30 Oct 2026", or one date when the range is a single day. */
export function describePeriod(period: Period): string {
  return period.from === period.to ? formatDate(period.from) : `${formatDate(period.from)} – ${formatDate(period.to)}`;
}

/**
 * The same range, compactly: "1–30 Sept 2026", "1 Sept – 30 Oct 2026", or both dates in full
 * across a year end. For tight labels; describePeriod is the full form.
 */
export function compactPeriod(period: Period): string {
  const [fromDay, fromMonth, fromYear] = formatDate(period.from).split(" ");
  const [toDay, toMonth, toYear] = formatDate(period.to).split(" ");
  if (period.from === period.to) return formatDate(period.from);
  if (fromYear !== toYear) return describePeriod(period);
  if (fromMonth !== toMonth) return `${fromDay ?? ""} ${fromMonth ?? ""} – ${toDay ?? ""} ${toMonth ?? ""} ${toYear ?? ""}`;
  return `${fromDay ?? ""}–${toDay ?? ""} ${toMonth ?? ""} ${toYear ?? ""}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A custom range's problem in plain words, or null when it is usable. */
export function customRangeError(from: string, to: string, today: BusinessDate = businessToday()): string | null {
  if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to)) return "Choose both a start and an end date.";
  if (from > to) return "The start date must be on or before the end date.";
  if (to > today) return "The end date cannot be in the future.";
  return null;
}
