// ---------------------------------------------------------------------------
// Unified money representation. Every monetary amount in the system is a BigInt
// count of KES cents (minor units): 1 KES = 100 cents. These are the only
// functions permitted to convert between the human decimal form and cents.
//
// NO FLOATING POINT ANYWHERE IN THIS FILE. There is no Number(), no
// parseFloat, and no arithmetic on a JS number — every conversion parses digits
// straight into bigint so binary floating point never touches a monetary value.
// Quantities and percentages are NOT money; do not route them through here
// (rate parsing below is the one exception, and it too is integer-only).
// ---------------------------------------------------------------------------

/** A monetary amount in KES cents (minor units). */
export type Cents = bigint;

// Largest magnitude we accept: 99,999,999,999,999 cents (~1 trillion KES). Any
// real MSME figure is far below this; the cap catches fat-fingered or hostile
// input before it reaches the ledger.
const MAX_CENTS: Cents = 999_999_999_999_99n;

/**
 * Parse an optionally-signed decimal string with at most two fractional digits
 * into cents. Throws a descriptive Error on empty input, more than two decimal
 * places, non-numeric characters, or a magnitude exceeding MAX_CENTS.
 */
export function parseMoneyToCents(input: string): Cents {
  if (typeof input !== "string") {
    throw new Error("parseMoneyToCents: expected a string.");
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("parseMoneyToCents: empty input.");
  }

  // Overall shape: optional minus, one-or-more integer digits, optional
  // fractional part. This rejects any non-numeric character, a leading plus,
  // whitespace inside, a bare "-", "1450." with no fraction, etc.
  const shape = /^-?\d+(?:\.\d+)?$/;
  if (!shape.test(trimmed)) {
    throw new Error(
      `parseMoneyToCents: "${input}" contains non-numeric characters or is malformed.`,
    );
  }

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;

  const dotIndex = unsigned.indexOf(".");
  const intDigits = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracDigits = dotIndex === -1 ? "" : unsigned.slice(dotIndex + 1);

  if (fracDigits.length > 2) {
    throw new Error(
      `parseMoneyToCents: "${input}" has more than 2 decimal places; money is limited to cents.`,
    );
  }

  // Pad the fractional part to exactly two digits, then concatenate: the whole
  // string is the cent count. BigInt(string) parses decimal digits directly —
  // no float, no Number().
  const fracPadded = (fracDigits + "00").slice(0, 2);
  const centsMagnitude = BigInt(intDigits + fracPadded);

  if (centsMagnitude > MAX_CENTS) {
    throw new Error(
      `parseMoneyToCents: "${input}" exceeds the maximum supported magnitude of ${MAX_CENTS.toString()} cents.`,
    );
  }

  return negative ? -centsMagnitude : centsMagnitude;
}

/** Render cents as a plain decimal string, e.g. 145000n -> "1450.00". Sign preserved. */
export function formatCents(cents: Cents): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  // Pad to at least 3 digits so there is always one integer digit plus two
  // fractional digits to slice.
  const digits = magnitude.toString().padStart(3, "0");
  const intPart = digits.slice(0, -2);
  const fracPart = digits.slice(-2);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

/** Render cents as a KES amount with thousands separators, e.g. 145000n -> "KES 1,450.00". */
export function formatCentsKes(cents: Cents): string {
  const plain = formatCents(cents);
  const negative = plain.startsWith("-");
  const unsigned = negative ? plain.slice(1) : plain;
  const dotIndex = unsigned.indexOf(".");
  const intPart = unsigned.slice(0, dotIndex);
  const fracPart = unsigned.slice(dotIndex + 1);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `KES ${negative ? "-" : ""}${grouped}.${fracPart}`;
}

/**
 * Exact integer division rounding halves away from zero. This is the ONLY
 * rounding primitive in the codebase — VAT and every other proportional
 * calculation must go through it so rounding is uniform and auditable.
 */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error("roundHalfUp: division by zero.");
  }

  // Normalise so the denominator is positive; fold its sign into the numerator.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const negative = n < 0n;
  const absN = negative ? -n : n;
  const quotient = absN / d;
  const remainder = absN % d;

  // Round up when twice the remainder reaches the denominator (i.e. the
  // fractional part is >= 0.5). Comparing 2*remainder to d keeps this exact.
  const rounded = 2n * remainder >= d ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Apply a percentage rate (given as a decimal string, e.g. "16.00") to a cent
 * base, rounding half away from zero. The rate is parsed to an integer number
 * of hundredths-of-a-percent, so "16.00" becomes 1600 and the effective divisor
 * is 10000 (100 to undo the percent, 100 to undo the hundredths).
 *   applyRatePercent(145000n, "16.00") === 23200n
 */
export function applyRatePercent(base: Cents, ratePercent: string): Cents {
  // parseMoneyToCents scales a 2-dp decimal string by 100 into an integer,
  // which is exactly "hundredths of a percent" for a rate — the same
  // float-free digit parsing, reused so there is a single parsing path.
  const rateHundredthsOfPercent = parseMoneyToCents(ratePercent);
  return roundHalfUp(base * rateHundredthsOfPercent, 10000n);
}
