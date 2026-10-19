// ===========================================================================
// THE VAT RULE (Task 3B.1) — pure; no database, no I/O.
//
// ONE place decides, for a sale line, (a) the KRA tax-type code it is charged under
// and (b) the rate it applies. The sale path stores both on the line; the receipt's
// code summary, the VAT return and the eTIMS invoice all READ what was stored. So the
// receipt a customer holds, the return a business files and the invoice KRA receives
// cannot disagree — they are the same decision, made once.
//
// KRA TAX-TYPE CODES (TIS for OSCU/VSCU Technical Specifications v2.0):
//   B  standard rate (16% under the VAT Act 2013, s.5(2)(b) — the RATE itself is
//      configuration on the effective StatutorySchedule, never a constant here)
//   C  zero-rated, 0% — vatable, the seller may still recover input VAT
//   A  exempt — outside VAT altogether
//   D  non-VAT — every line of a seller who is NOT registered for VAT
//   (E, the former 8% petroleum rate, was deleted from July 2023 and is never emitted.)
//
// OUTPUT VAT APPLIES ONLY TO A VAT-REGISTERED SELLER, ON A STANDARD-RATED LINE. A
// Turnover Tax or exempt business charges no VAT on anything, whatever the product's
// class: it has no right to collect it, and KRA sees every eTIMS invoice it issues.
// ===========================================================================

import type { KraTaxCode, TaxClass } from "../generated/tenant/enums";

/** The KRA tax-type code a line is charged under. THE mapping — there is no other. */
export function kraTaxCode(taxClass: TaxClass, isVatRegistered: boolean): KraTaxCode {
  if (!isVatRegistered) {
    return "D";
  }
  switch (taxClass) {
    case "STANDARD_RATED":
      return "B";
    case "ZERO_RATED":
      return "C";
    case "EXEMPT":
      return "A";
  }
}

/** The rate a line applies, as a decimal-percentage string. Only code B carries one. */
export function appliedVatRate(code: KraTaxCode, standardRate: string): string {
  return code === "B" ? standardRate : "0.00";
}

/**
 * The code and class of a sale line as READ BACK. A pre-3B.1 line stored neither; per
 * the NULL-means-default rule it is STANDARD_RATED / B, which is exactly how it was
 * charged — every product was 16% standard-rated before Task 3B.1.
 */
export function effectiveLineTax(line: {
  taxClass: TaxClass | null;
  taxCode: KraTaxCode | null;
}): { taxClass: TaxClass; taxCode: KraTaxCode } {
  return {
    taxClass: line.taxClass ?? "STANDARD_RATED",
    taxCode: line.taxCode ?? "B",
  };
}

/** How a code reads on a receipt. */
export function kraTaxCodeLabel(code: KraTaxCode): string {
  switch (code) {
    case "B":
      return "Standard rated";
    case "C":
      return "Zero rated";
    case "A":
      return "Exempt";
    case "D":
      return "No VAT — not VAT registered";
  }
}
