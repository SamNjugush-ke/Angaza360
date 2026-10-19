// Pure unit tests for src/lib/vat.ts — THE class+regime -> KRA code mapping (the engineering ledger
// "VAT Model", KRA TIS for OSCU/VSCU v2.0). No database.

import { describe, expect, it } from "vitest";
import { appliedVatRate, effectiveLineTax, kraTaxCode, kraTaxCodeLabel } from "../../src/lib/vat";
import type { KraTaxCode, TaxClass } from "../../src/generated/tenant/enums";

const ALL_CLASSES: readonly TaxClass[] = ["STANDARD_RATED", "ZERO_RATED", "EXEMPT"];
const ALL_CODES: readonly KraTaxCode[] = ["A", "B", "C", "D"];

describe("kraTaxCode — the full table", () => {
  it.each(ALL_CLASSES)("a NOT-registered seller files %s as D (non-VAT)", (taxClass) => {
    expect(kraTaxCode(taxClass, false)).toBe("D");
  });

  it.each<[TaxClass, KraTaxCode]>([
    ["STANDARD_RATED", "B"],
    ["ZERO_RATED", "C"],
    ["EXEMPT", "A"],
  ])("a VAT-registered seller files %s as %s", (taxClass, code) => {
    expect(kraTaxCode(taxClass, true)).toBe(code);
  });

  it("only ever emits the four live codes (E, the deleted 8% rate, is not even representable)", () => {
    for (const taxClass of ALL_CLASSES) {
      for (const registered of [true, false]) {
        expect(ALL_CODES).toContain(kraTaxCode(taxClass, registered));
      }
    }
  });
});

describe("appliedVatRate", () => {
  it("returns the schedule's standard rate for code B only", () => {
    expect(appliedVatRate("B", "16.00")).toBe("16.00");
    expect(appliedVatRate("B", "15.00")).toBe("15.00");
  });

  it.each(ALL_CODES.filter((code) => code !== "B"))("returns \"0.00\" for code %s", (code) => {
    expect(appliedVatRate(code, "16.00")).toBe("0.00");
  });
});

describe("effectiveLineTax — NULL means STANDARD_RATED / B (pre-3B.1 lines)", () => {
  it("defaults a line that stored neither class nor code", () => {
    expect(effectiveLineTax({ taxClass: null, taxCode: null })).toEqual({
      taxClass: "STANDARD_RATED",
      taxCode: "B",
    });
  });

  it("returns what a post-3B.1 line stored, unchanged", () => {
    expect(effectiveLineTax({ taxClass: "ZERO_RATED", taxCode: "C" })).toEqual({
      taxClass: "ZERO_RATED",
      taxCode: "C",
    });
    expect(effectiveLineTax({ taxClass: "EXEMPT", taxCode: "D" })).toEqual({
      taxClass: "EXEMPT",
      taxCode: "D",
    });
  });
});

describe("kraTaxCodeLabel", () => {
  it("labels the D line of a non-registered seller explicitly", () => {
    expect(kraTaxCodeLabel("D")).toBe("No VAT — not VAT registered");
    expect(kraTaxCodeLabel("B")).toBe("Standard rated");
  });
});
