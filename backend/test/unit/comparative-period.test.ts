// ===========================================================================
// THE COMPARATIVE PERIOD (M4.5 W3): one convention for "the period before", shared by every
// Module 13 statement and the dashboard. Month to date compares with the SAME DAYS of the previous
// month, year to date with the same days of the previous year; whole months and years with the
// previous whole one; any other span with the equal span just before it.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { comparativePeriodOf } from "../../src/services/reports";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);
const prior = (from: string, to: string) => {
  const p = comparativePeriodOf({ from: d(from), to: d(to) });
  return [iso(p.from), iso(p.to)];
};

describe("comparativePeriodOf", () => {
  it("month to date is compared with the same days of the previous month — never the days just before it", () => {
    expect(prior("2026-11-01", "2026-11-16")).toEqual(["2026-10-01", "2026-10-16"]);
    expect(prior("2026-11-01", "2026-11-01")).toEqual(["2026-10-01", "2026-10-01"]);
  });

  it("clamps to the previous month's last day, and crosses a year end", () => {
    expect(prior("2026-03-01", "2026-03-30")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(prior("2027-01-01", "2027-01-10")).toEqual(["2026-12-01", "2026-12-10"]);
  });

  it("a whole month is compared with the previous whole month, a whole year with the previous year", () => {
    expect(prior("2026-10-01", "2026-10-31")).toEqual(["2026-09-01", "2026-09-30"]);
    expect(prior("2026-01-01", "2026-12-31")).toEqual(["2025-01-01", "2025-12-31"]);
  });

  it("year to date is compared with the same days of the previous year", () => {
    expect(prior("2026-01-01", "2026-11-16")).toEqual(["2025-01-01", "2025-11-16"]);
    expect(prior("2028-01-01", "2028-02-29")).toEqual(["2027-01-01", "2027-02-28"]);
  });

  it("any other span is compared with the equal span just before it", () => {
    expect(prior("2026-11-05", "2026-11-14")).toEqual(["2026-10-26", "2026-11-04"]);
    expect(prior("2026-10-15", "2026-11-14")).toEqual(["2026-09-14", "2026-10-14"]);
  });
});
