import { describe, expect, it } from "vitest";
import {
  addCents,
  formatKES,
  formatKESCompact,
  parseCents,
  parseMajorToCents,
  subCents,
} from "@/lib/money";

describe("parseCents", () => {
  it("parses a backend cents string and passes a bigint through", () => {
    expect(parseCents("248050000")).toBe(248050000n);
    expect(parseCents("-6300")).toBe(-6300n);
    expect(parseCents("0")).toBe(0n);
    expect(parseCents(42n)).toBe(42n);
  });

  it.each(["", " ", "1.5", "12.00", "1e3", "+5", "--1", "12a", " 12", "0x10", "1,000"])(
    "rejects %j",
    (input) => {
      expect(() => parseCents(input)).toThrow(TypeError);
    },
  );
});

describe("formatKES", () => {
  it("formats en-KE with exactly two minor digits", () => {
    expect(formatKES("248050000", { currency: true })).toBe("KES 2,480,500.00");
    expect(formatKES("248050000")).toBe("2,480,500.00");
    expect(formatKES("100000")).toBe("1,000.00");
  });

  it("formats zero", () => {
    expect(formatKES("0")).toBe("0.00");
    expect(formatKES(0n, { currency: true })).toBe("KES 0.00");
    expect(formatKES(0n, { sign: "always" })).toBe("0.00");
  });

  it("formats negatives", () => {
    expect(formatKES("-6300")).toBe("-63.00");
    expect(formatKES("-6300", { currency: true })).toBe("-KES 63.00");
    expect(formatKES("-248050000")).toBe("-2,480,500.00");
  });

  it("formats sub-KES amounts", () => {
    expect(formatKES("1")).toBe("0.01");
    expect(formatKES("5")).toBe("0.05");
    expect(formatKES("99")).toBe("0.99");
    expect(formatKES("-1")).toBe("-0.01");
  });

  it("honours the sign option", () => {
    expect(formatKES("6300", { sign: "always" })).toBe("+63.00");
    expect(formatKES("-6300", { sign: "always" })).toBe("-63.00");
    expect(formatKES("-6300", { sign: "never" })).toBe("63.00");
    expect(formatKES("6300", { sign: "auto" })).toBe("63.00");
  });

  it("formats a bigint far beyond Number.MAX_SAFE_INTEGER exactly", () => {
    // 2^53 + 1 cents cannot be represented by a JS number; the output must not lose the last digit.
    expect(formatKES((2n ** 53n + 1n).toString())).toBe("90,071,992,547,409.93");
    expect(formatKES("123456789012345678901234567")).toBe("1,234,567,890,123,456,789,012,345.67");
  });
});

describe("parseMajorToCents", () => {
  it("parses grouped and ungrouped amounts", () => {
    expect(parseMajorToCents("2,480,500.00")).toBe(248050000n);
    expect(parseMajorToCents("2480500")).toBe(248050000n);
    expect(parseMajorToCents("63.5")).toBe(6350n);
    expect(parseMajorToCents("0.05")).toBe(5n);
    expect(parseMajorToCents("-63.00")).toBe(-6300n);
    expect(parseMajorToCents("  1,000  ")).toBe(100000n);
  });

  it.each(["", "abc", "1.234", "1,00", "1,0000", ",100", "1.", ".5", "KES 100", "1e3", "12-3", "--1", "1 000"])(
    "rejects %j",
    (input) => {
      expect(() => parseMajorToCents(input)).toThrow(TypeError);
    },
  );

  it("round-trips with formatKES", () => {
    for (const cents of [0n, 1n, 99n, 100n, 6300n, -6300n, 248050000n, 2n ** 70n, -(2n ** 70n) - 7n]) {
      expect(parseMajorToCents(formatKES(cents))).toBe(cents);
    }
  });
});

describe("formatKESCompact", () => {
  it("abbreviates by magnitude to three significant figures", () => {
    expect(formatKESCompact("248050000", { currency: true })).toBe("KES 2.48M");
    expect(formatKESCompact("94200000")).toBe("942K");
    expect(formatKESCompact("100000")).toBe("1K");
    expect(formatKESCompact("123456700")).toBe("1.23M");
    expect(formatKESCompact("1250000000000")).toBe("12.5B");
    expect(formatKESCompact("-94200000")).toBe("-942K");
  });

  it("rounds half-up and carries into the next unit", () => {
    expect(formatKESCompact("248500000")).toBe("2.49M"); // 2,485,000 → 2.49M
    expect(formatKESCompact("99950000")).toBe("1M"); // 999,500 → 1000K → 1M
    expect(formatKESCompact("999500000")).toBe("10M"); // 9,995,000 → 10.0M → 10M
  });

  it("shows amounts under KES 1,000 exactly", () => {
    expect(formatKESCompact("95050")).toBe("950.50");
    expect(formatKESCompact("0", { currency: true })).toBe("KES 0.00");
  });

  it("stays exact on a very large bigint", () => {
    expect(formatKESCompact((10n ** 20n).toString())).toBe("1,000,000T");
  });
});

describe("addCents / subCents", () => {
  it("adds and subtracts bigints without loss", () => {
    expect(addCents(2n ** 60n, 1n)).toBe(1152921504606846977n);
    expect(subCents(100n, 6300n)).toBe(-6200n);
  });
});
