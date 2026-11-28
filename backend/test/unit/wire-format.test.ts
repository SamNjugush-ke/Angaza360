// ===========================================================================
// THE MONEY WIRE FORMAT (the engineering ledger "API Documentation Is Schema-Driven (Law)" and
// "Money Representation (Settled)"): money is a STRING on the wire in both
// directions, never a JSON number.
//
// Tested against the real Zod schemas every route uses (src/schemas/common.ts):
//   in  — zMoney / zMoneyNonNegative accept only decimal strings the money parser
//         accepts, and refuse a JSON number outright;
//   out — zCentsString encodes a bigint to a string of integer cents, exactly, far
//         beyond 2^53, so the serialised JSON carries a quoted string.
// No database; no HTTP (HTTP-level route coverage is deferred to T-A2+).
// ===========================================================================

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  zCentsString,
  zCentsStringNullable,
  zMoney,
  zMoneyNonNegative,
} from "../../src/schemas/common";

describe("money IN: decimal strings only", () => {
  it.each(["0", "1250", "1250.5", "1250.00", "-12.34"])("zMoney accepts %j", (value) => {
    expect(zMoney.safeParse(value).success).toBe(true);
  });

  it.each<unknown>([1250, 1250.5, 0, null, true, "1250.001", "12,50", "1e3", ""])(
    "zMoney refuses %j (a JSON number is never money)",
    (value) => {
      expect(zMoney.safeParse(value).success).toBe(false);
    },
  );

  it("zMoneyNonNegative refuses a negative amount and a JSON number", () => {
    expect(zMoneyNonNegative.safeParse("10.00").success).toBe(true);
    expect(zMoneyNonNegative.safeParse("-0.01").success).toBe(false);
    expect(zMoneyNonNegative.safeParse(10).success).toBe(false);
  });

  it("a request body with money as a JSON number is rejected by the schema", () => {
    const body = z.object({ amount: zMoney });
    expect(body.safeParse(JSON.parse('{"amount":"1250.00"}')).success).toBe(true);
    expect(body.safeParse(JSON.parse('{"amount":1250.00}')).success).toBe(false);
  });
});

describe("money OUT: a bigint is encoded as a string of integer cents", () => {
  it("encodes exactly, including beyond Number.MAX_SAFE_INTEGER", () => {
    const beyond = 2n ** 64n + 1n; // 18446744073709551617 — a double would round it
    expect(z.encode(zCentsString, 125000n)).toBe("125000");
    expect(z.encode(zCentsString, -1n)).toBe("-1");
    expect(z.encode(zCentsString, beyond)).toBe("18446744073709551617");
    expect(String(Number(beyond))).not.toBe("18446744073709551617");
  });

  it("a response object serialises money as a QUOTED string, never a JSON number", () => {
    const response = z.object({ total: zCentsString, closingFloat: zCentsStringNullable });
    const wire = JSON.stringify(z.encode(response, { total: 9007199254740993n, closingFloat: null }));
    expect(wire).toBe('{"total":"9007199254740993","closingFloat":null}');
    expect(JSON.parse(wire)).toEqual({ total: "9007199254740993", closingFloat: null });
  });

  it("decodes the wire string back to the exact bigint, and refuses a JSON number", () => {
    expect(z.decode(zCentsString, "9007199254740993")).toBe(9007199254740993n);
    expect(zCentsString.safeParse(9007199254740993).success).toBe(false);
    expect(zCentsString.safeParse("12.50").success).toBe(false);
  });
});
