// Pure unit tests for src/lib/money.ts — the ONE rounding primitive and the ONE money
// parser (the engineering ledger "Money Representation (Settled)"). No database.
//
// (Placed in test/unit rather than colocated in src/lib: T-A1 changes no file under
// backend/src, and tsconfig.json compiles everything under src into dist.)

import { describe, expect, it } from "vitest";
import {
  applyRatePercent,
  formatCents,
  formatCentsKes,
  parseMoneyToCents,
  roundHalfUp,
} from "../../src/lib/money";

describe("roundHalfUp — half away from zero, exact integer arithmetic", () => {
  it.each<[bigint, bigint, bigint]>([
    [5n, 2n, 3n], // 2.5  -> 3
    [3n, 2n, 2n], // 1.5  -> 2
    [7n, 3n, 2n], // 2.33 -> 2
    [8n, 3n, 3n], // 2.67 -> 3
    [10n, 5n, 2n], // exact
    [0n, 7n, 0n],
    [1n, 3n, 0n], // 0.33 -> 0
    [1n, 2n, 1n], // 0.5  -> 1
    [-5n, 2n, -3n], // -2.5 -> -3 (AWAY from zero, not toward +inf)
    [-3n, 2n, -2n], // -1.5 -> -2
    [-7n, 3n, -2n],
    [-1n, 2n, -1n], // -0.5 -> -1
    [5n, -2n, -3n], // the denominator's sign folds into the numerator
    [-5n, -2n, 3n],
  ])("roundHalfUp(%s, %s) === %s", (numerator, denominator, expected) => {
    expect(roundHalfUp(numerator, denominator)).toBe(expected);
  });

  it("refuses a zero divisor rather than returning Infinity or NaN", () => {
    expect(() => roundHalfUp(1n, 0n)).toThrow(/division by zero/);
    expect(() => roundHalfUp(0n, 0n)).toThrow(/division by zero/);
  });

  it("stays exact far beyond 2^53", () => {
    const huge = 2n ** 80n + 1n;
    expect(roundHalfUp(huge * 2n + 1n, 2n)).toBe(huge + 1n);
  });
});

describe("applyRatePercent", () => {
  it("applies the standard VAT worked example: 1,450.00 at 16.00% is 232.00", () => {
    expect(applyRatePercent(145000n, "16.00")).toBe(23200n);
  });

  it("rounds the result once, half away from zero", () => {
    // 8,333.00 at 25% = 2,083.25 exactly (the PAYE band example in the engineering ledger).
    expect(applyRatePercent(833300n, "25")).toBe(208325n);
    // 0.05 at 10% = 0.005 -> 0.01
    expect(applyRatePercent(5n, "10.00")).toBe(1n);
    // -0.05 at 10% = -0.005 -> -0.01
    expect(applyRatePercent(-5n, "10.00")).toBe(-1n);
  });

  it("a zero rate yields zero", () => {
    expect(applyRatePercent(999999n, "0.00")).toBe(0n);
  });
});

describe("parseMoneyToCents", () => {
  it.each<[string, bigint]>([
    ["0", 0n],
    ["1", 100n],
    ["1.5", 150n],
    ["1.05", 105n],
    ["1450.00", 145000n],
    ["-12.34", -1234n],
    ["  7.10 ", 710n],
    ["999999999999.99", 99999999999999n],
  ])("parses %j to %s cents", (input, expected) => {
    expect(parseMoneyToCents(input)).toBe(expected);
  });

  it("rejects more than two decimal places — money is limited to cents", () => {
    expect(() => parseMoneyToCents("1.234")).toThrow(/more than 2 decimal places/);
    expect(() => parseMoneyToCents("0.001")).toThrow(/more than 2 decimal places/);
  });

  it.each(["", "   ", "abc", "1,000.00", "+5", "1.", ".5", "1e3", "--1", "1 000", "NaN", "Infinity", "0x10"])(
    "rejects malformed input %j",
    (input) => {
      expect(() => parseMoneyToCents(input)).toThrow();
    },
  );

  it("rejects a magnitude above MAX_CENTS", () => {
    expect(() => parseMoneyToCents("1000000000000.00")).toThrow(/exceeds the maximum/);
    expect(() => parseMoneyToCents("-1000000000000.00")).toThrow(/exceeds the maximum/);
  });

  it("has no floating-point path: amounts a double mangles parse exactly", () => {
    // Each of these, routed through Number(s) * 100, is NOT the integer cent count.
    // The parser concatenates digits into a bigint and never forms a JS number.
    const floatTraps: Array<[string, bigint]> = [
      ["0.29", 29n], // 28.999999999999996 as a float
      ["1.15", 115n], // 114.99999999999999
      ["4.35", 435n], // 434.99999999999994
      ["562949953421.31", 56294995342131n], // 56294995342131.01
    ];
    for (const [input, cents] of floatTraps) {
      expect(Number.isInteger(Number(input) * 100) && BigInt(Number(input) * 100) === cents).toBe(false);
      expect(parseMoneyToCents(input)).toBe(cents);
    }
  });

  it("parses a 17-significant-figure string digit-for-digit: refused on magnitude, never rounded", () => {
    // MAX_CENTS is 14 significant figures (999,999,999,999.99), so ANY 17-significant-
    // figure amount is out of range. A float parser would first round it to the nearest
    // double (123456789012345.67 -> 123456789012345.67187...) — this one sees the exact
    // digits and refuses the magnitude instead of accepting an approximation.
    expect(String(Number("123456789012345.67") * 100)).not.toBe("12345678901234567");
    expect(() => parseMoneyToCents("123456789012345.67")).toThrow(/exceeds the maximum/);
    expect(() => parseMoneyToCents("-123456789012345.67")).toThrow(/exceeds the maximum/);
    // The full 14-significant-figure maximum survives intact.
    expect(parseMoneyToCents("999999999999.99")).toBe(99999999999999n);
  });
});

describe("formatCents round-trip", () => {
  it.each(["0.00", "0.01", "0.10", "1.00", "1450.00", "-0.01", "-12.34", "999999999999.99"])(
    "formatCents(parseMoneyToCents(%j)) is the identity",
    (input) => {
      expect(formatCents(parseMoneyToCents(input))).toBe(input);
    },
  );

  it("normalises equivalent spellings to two places", () => {
    expect(formatCents(parseMoneyToCents("7"))).toBe("7.00");
    expect(formatCents(parseMoneyToCents("7.5"))).toBe("7.50");
  });

  it("formats with KES grouping", () => {
    expect(formatCentsKes(123456789n)).toBe("KES 1,234,567.89");
    expect(formatCentsKes(-100n)).toBe("KES -1.00");
  });
});
