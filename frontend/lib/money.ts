// KES money for the Angaza360 frontend.
//
// NO FLOATING POINT. Money is a BigInt count of KES cents, exactly as the backend stores it,
// and it crosses the wire as a decimal STRING of cents. Nothing in this file converts a money
// value to a JS number: no Number(), no parseFloat, no arithmetic on a number. Grouping goes
// through Intl.NumberFormat, which formats a BigInt exactly. The frontend FORMATS money; it
// never computes a ledger figure (see the engineering ledger, "Money Representation").

const CENTS_PER_KES = 100n;
const INTEGER_CENTS = /^-?\d+$/;
// Optional minus, a whole part either ungrouped or grouped in threes, then up to 2 decimals.
const MAJOR_AMOUNT = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

const groupFormatter = new Intl.NumberFormat("en-KE", { useGrouping: true, maximumFractionDigits: 0 });

export type Cents = bigint;
export type SignDisplay = "auto" | "always" | "never";

export interface FormatKESOptions {
  /** Prefix "KES ". Default false. */
  currency?: boolean;
  /** "auto" (default): minus on negatives only; "always": a "+" on positives too; "never": no sign. */
  sign?: SignDisplay;
}

/** Parses a backend cents string (or passes a bigint through). Rejects anything but an integer. */
export function parseCents(input: string | bigint): Cents {
  if (typeof input === "bigint") return input;
  if (!INTEGER_CENTS.test(input)) {
    throw new TypeError(`Not an integer count of cents: "${input}"`);
  }
  return BigInt(input);
}

function signPrefix(cents: Cents, sign: SignDisplay): string {
  if (sign === "never" || cents === 0n) return "";
  if (cents < 0n) return "-";
  return sign === "always" ? "+" : "";
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** en-KE money: comma thousands, dot decimal, exactly two minor digits. "248050000" → "2,480,500.00". */
export function formatKES(cents: string | bigint, opts: FormatKESOptions = {}): string {
  const value = parseCents(cents);
  const magnitude = abs(value);
  const major = groupFormatter.format(magnitude / CENTS_PER_KES);
  const minor = (magnitude % CENTS_PER_KES).toString().padStart(2, "0");
  return `${signPrefix(value, opts.sign ?? "auto")}${opts.currency ? "KES " : ""}${major}.${minor}`;
}

const COMPACT_UNITS: ReadonlyArray<readonly [string, bigint]> = [
  ["T", 1_000_000_000_000n],
  ["B", 1_000_000_000n],
  ["M", 1_000_000n],
  ["K", 1_000n],
];
const SIGNIFICANT_DIGITS = 3;

/** Integer division rounded half-up, for non-negative operands. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

/** Renders a non-negative value scaled by 10^decimals, grouped, with trailing fraction zeros trimmed. */
function renderScaled(scaled: bigint, decimals: number): string {
  if (decimals === 0) return groupFormatter.format(scaled);
  const factor = 10n ** BigInt(decimals);
  const whole = groupFormatter.format(scaled / factor);
  const fraction = (scaled % factor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Dense mobile form, three significant figures: 248050000 cents → "2.48M", 94200000 → "942K".
 * Under KES 1,000 the exact amount is shown (formatKES). Derived from the bigint alone.
 */
export function formatKESCompact(cents: string | bigint, opts: Pick<FormatKESOptions, "currency"> = {}): string {
  const value = parseCents(cents);
  const magnitude = abs(value);
  const prefix = `${value < 0n ? "-" : ""}${opts.currency ? "KES " : ""}`;

  let unitIndex = COMPACT_UNITS.findIndex(([, size]) => magnitude >= size * CENTS_PER_KES);
  if (unitIndex === -1) return formatKES(value, { currency: opts.currency });

  for (;;) {
    const [suffix, size] = COMPACT_UNITS[unitIndex];
    const divisor = size * CENTS_PER_KES;
    const wholeDigits = (magnitude / divisor).toString().length;
    let decimals = Math.max(0, SIGNIFICANT_DIGITS - wholeDigits);
    let scaled = divideHalfUp(magnitude * 10n ** BigInt(decimals), divisor);
    // Rounding can carry into a new digit (9.995M → 10.0M); drop a decimal to stay at 3 figures.
    if (decimals > 0 && scaled >= 10n ** BigInt(SIGNIFICANT_DIGITS)) {
      decimals -= 1;
      scaled = divideHalfUp(magnitude * 10n ** BigInt(decimals), divisor);
    }
    // 999.5K rounds to 1000K: promote to the next unit ("1M") when there is one.
    if (decimals === 0 && scaled >= 1000n && unitIndex > 0) {
      unitIndex -= 1;
      continue;
    }
    return `${prefix}${renderScaled(scaled, decimals)}${suffix}`;
  }
}

/** Parses a typed major-unit amount: "2,480,500.00" → 248050000n. Grouping must be correct; ≤ 2 decimals. */
export function parseMajorToCents(input: string): Cents {
  const match = MAJOR_AMOUNT.exec(input.trim());
  if (!match) {
    throw new TypeError(`Not a KES amount: "${input}"`);
  }
  const [, minus, whole, fraction = ""] = match;
  const cents = BigInt(whole.replace(/,/g, "")) * CENTS_PER_KES + BigInt(fraction.padEnd(2, "0"));
  return minus ? -cents : cents;
}

export function addCents(a: Cents, b: Cents): Cents {
  return a + b;
}

export function subCents(a: Cents, b: Cents): Cents {
  return a - b;
}

/**
 * Cents as the API's decimal amount string — no grouping, no currency, exactly two minor digits:
 * 248050000n → "2480500.00". What a money field SENDS (the backend's zMoney parses it), and what
 * an edit form PRE-FILLS from a stored price.
 */
export function centsToAmount(cents: string | bigint): string {
  const value = parseCents(cents);
  const magnitude = abs(value);
  const minor = (magnitude % CENTS_PER_KES).toString().padStart(2, "0");
  return `${value < 0n ? "-" : ""}${(magnitude / CENTS_PER_KES).toString()}.${minor}`;
}
