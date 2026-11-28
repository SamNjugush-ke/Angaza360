import { describe, expect, it } from "vitest";
import {
  BUSINESS_TZ,
  businessToday,
  comparisonPeriodOf,
  equivalentPriorPeriod,
  formatDate,
  monthToDate,
  pctDelta,
  toBusinessDate,
} from "@/lib/datetime";

describe("the suite runs away from Nairobi", () => {
  it("is not on East Africa Time, so host-offset leaks would show", () => {
    expect(BUSINESS_TZ).toBe("Africa/Nairobi");
    expect(new Date("2026-10-20T00:00:00Z").getTimezoneOffset()).not.toBe(-180);
  });
});

describe("toBusinessDate / businessToday", () => {
  it("cuts the day in Nairobi across a UTC-midnight boundary", () => {
    // 22:30 UTC on 31 Oct is 01:30 on 1 Nov in Nairobi: a NOVEMBER business day.
    expect(toBusinessDate(new Date("2026-10-31T22:30:00Z"))).toBe("2026-11-01");
    expect(toBusinessDate("2026-10-31T22:30:00Z")).toBe("2026-11-01");
    // 20:59 UTC is 23:59 Nairobi: still the same day.
    expect(toBusinessDate("2026-10-31T20:59:59Z")).toBe("2026-10-31");
    // 21:00 UTC is midnight in Nairobi: the next day.
    expect(toBusinessDate("2026-10-31T21:00:00Z")).toBe("2026-11-01");
    // UTC midnight is 03:00 in Nairobi — the same date.
    expect(toBusinessDate("2026-10-20T00:00:00Z")).toBe("2026-10-20");
    // Year boundary.
    expect(toBusinessDate("2026-12-31T21:30:00Z")).toBe("2027-01-01");
  });

  it("treats a date-only string as the calendar day, not as midnight UTC", () => {
    expect(toBusinessDate("2026-10-20")).toBe("2026-10-20");
  });

  it("rejects invalid input", () => {
    expect(() => toBusinessDate("2026-02-30")).toThrow(TypeError);
    expect(() => toBusinessDate("not a date")).toThrow(TypeError);
  });

  it("gives today in Nairobi", () => {
    expect(businessToday(new Date("2026-10-31T22:30:00Z"))).toBe("2026-11-01");
    expect(businessToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatDate", () => {
  it("formats en-KE in each style", () => {
    expect(formatDate("2026-10-20")).toBe("20 Oct 2026");
    expect(formatDate("2026-10-20", "medium")).toBe("20 Oct 2026");
    expect(formatDate("2026-10-20", "short")).toBe("20/10/2026");
    expect(formatDate("2026-10-20", "weekday")).toBe("Tue 20 Oct 2026");
  });

  it("formats an instant as its Nairobi day", () => {
    expect(formatDate("2026-10-31T22:30:00Z", "weekday")).toBe("Sun 1 Nov 2026");
    expect(formatDate(new Date("2026-10-20T00:00:00Z"))).toBe("20 Oct 2026");
  });
});

describe("monthToDate", () => {
  it("runs from the first of the month to the reference day", () => {
    expect(monthToDate("2026-10-20")).toEqual({ from: "2026-10-01", to: "2026-10-20" });
    expect(monthToDate("2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  });

  it("uses the Nairobi day of an instant", () => {
    // 22:30 UTC on 31 Oct is already November in Nairobi: November to date, one day long.
    expect(monthToDate(new Date("2026-10-31T22:30:00Z"))).toEqual({ from: "2026-11-01", to: "2026-11-01" });
  });
});

describe("equivalentPriorPeriod", () => {
  it("is the same span in the prior month, not the whole prior month", () => {
    expect(equivalentPriorPeriod({ from: "2026-10-01", to: "2026-10-20" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-20",
    });
  });

  it("crosses a year boundary", () => {
    expect(equivalentPriorPeriod({ from: "2027-01-01", to: "2027-01-15" })).toEqual({
      from: "2026-12-01",
      to: "2026-12-15",
    });
  });

  it("clamps a day the prior month lacks", () => {
    expect(equivalentPriorPeriod({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(equivalentPriorPeriod({ from: "2028-03-01", to: "2028-03-30" })).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(equivalentPriorPeriod({ from: "2026-10-01", to: "2026-10-31" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("composes with monthToDate", () => {
    expect(equivalentPriorPeriod(monthToDate("2026-10-20"))).toEqual({ from: "2026-09-01", to: "2026-09-20" });
  });

  it("refuses a period that starts after it ends", () => {
    expect(() => equivalentPriorPeriod({ from: "2026-10-20", to: "2026-10-01" })).toThrow(RangeError);
  });
});

describe("pctDelta", () => {
  it("is null for a zero or negative baseline", () => {
    expect(pctDelta(500n, 0n)).toBeNull();
    expect(pctDelta(0n, 0n)).toBeNull();
    expect(pctDelta(500n, -100n)).toBeNull();
  });

  it("computes the change to two decimals", () => {
    expect(pctDelta(150n, 100n)).toBe(50);
    expect(pctDelta(50n, 100n)).toBe(-50);
    expect(pctDelta(100n, 100n)).toBe(0);
    expect(pctDelta(0n, 100n)).toBe(-100);
    expect(pctDelta(2n, 3n)).toBe(-33.33);
    expect(pctDelta(1n, 3n)).toBe(-66.67);
  });

  it("stays exact on large bigint amounts", () => {
    expect(pctDelta(2n ** 64n + 2n ** 62n, 2n ** 64n)).toBe(25);
  });
});

describe("comparisonPeriodOf — the fair comparison for each kind of period", () => {
  it("month to date: the same days of the prior month", () => {
    expect(comparisonPeriodOf({ from: "2026-10-01", to: "2026-10-31" }, "month-to-date")).toEqual({
      period: { from: "2026-09-01", to: "2026-09-30" },
      label: "last month",
    });
    expect(comparisonPeriodOf({ from: "2027-01-01", to: "2027-01-15" }, "month-to-date").period).toEqual({ from: "2026-12-01", to: "2026-12-15" });
  });

  it("a whole month: the whole month before, whatever its length", () => {
    expect(comparisonPeriodOf({ from: "2026-09-01", to: "2026-09-30" }, "month")).toEqual({
      period: { from: "2026-08-01", to: "2026-08-31" },
      label: "previous month",
    });
    expect(comparisonPeriodOf({ from: "2026-03-01", to: "2026-03-31" }, "month").period).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(comparisonPeriodOf({ from: "2026-01-01", to: "2026-01-31" }, "month").period).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("year to date: the same days of the prior YEAR (not a month back)", () => {
    expect(comparisonPeriodOf({ from: "2026-01-01", to: "2026-10-31" }, "year-to-date")).toEqual({
      period: { from: "2025-01-01", to: "2025-10-31" },
      label: "last year",
    });
    // 29 Feb has no twin in a common year.
    expect(comparisonPeriodOf({ from: "2028-01-01", to: "2028-02-29" }, "year-to-date").period).toEqual({ from: "2027-01-01", to: "2027-02-28" });
  });

  it("custom: the immediately preceding span of equal length", () => {
    expect(comparisonPeriodOf({ from: "2026-10-20", to: "2026-10-25" }, "custom")).toEqual({
      period: { from: "2026-10-14", to: "2026-10-19" },
      label: "previous period",
    });
  });

  // M4.5 W3: decided by the period's SHAPE, whatever preset produced it — the same table as the
  // backend's test/unit/comparative-period.test.ts, so the dashboard and the income statement agree.
  it("uses the SAME convention as the income statement, by the period's shape", () => {
    const cases: Array<[string, string, string, string]> = [
      ["2026-11-01", "2026-11-16", "2026-10-01", "2026-10-16"],
      ["2026-11-01", "2026-11-01", "2026-10-01", "2026-10-01"],
      ["2026-03-01", "2026-03-30", "2026-02-01", "2026-02-28"],
      ["2027-01-01", "2027-01-10", "2026-12-01", "2026-12-10"],
      ["2026-10-01", "2026-10-31", "2026-09-01", "2026-09-30"],
      ["2026-01-01", "2026-12-31", "2025-01-01", "2025-12-31"],
      ["2026-01-01", "2026-11-16", "2025-01-01", "2025-11-16"],
      ["2028-01-01", "2028-02-29", "2027-01-01", "2027-02-28"],
      ["2026-11-05", "2026-11-14", "2026-10-26", "2026-11-04"],
      ["2026-10-15", "2026-11-14", "2026-09-14", "2026-10-14"],
    ];
    for (const kind of ["custom", "month-to-date", "month", "year-to-date"] as const) {
      for (const [from, to, priorFrom, priorTo] of cases) {
        expect(comparisonPeriodOf({ from, to }, kind).period, `${kind} ${from}..${to}`).toEqual({ from: priorFrom, to: priorTo });
      }
    }
  });

  it("refuses a period that ends before it starts", () => {
    expect(() => comparisonPeriodOf({ from: "2026-10-05", to: "2026-10-01" }, "custom")).toThrow(RangeError);
  });
});
