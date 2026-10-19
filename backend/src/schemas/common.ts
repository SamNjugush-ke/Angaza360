// ===========================================================================
// Shared Zod schema vocabulary (Task G.3). Every route's schema is built from
// these, so the API's conventions are defined once and cannot drift per route.
//
// A route's Zod schema is simultaneously THREE things:
//   1. the runtime request validator,
//   2. the TypeScript type of request.body/params/query in the handler,
//   3. the OpenAPI document served at /docs.
// There is no second place where any of the three is written down, so they
// cannot disagree.
//
// MONEY IS NEVER A JSON NUMBER — not on input, not on output, not in the
// documented schema. On INPUT money is a decimal string ("1250.00"); on OUTPUT
// it is a string of integer minor units ("125000" cents), because that is what
// the system actually stores. A JSON number for money is rejected by the
// validator, and the OpenAPI spec says "string" so no client generator ever
// produces a float for a shilling.
// ===========================================================================

import { z } from "zod";
import { parseMoneyToCents } from "../lib/money";
import { businessToday } from "../lib/business-time";
import { decimalToMilli } from "../lib/inventory-math";

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

// Documented pattern for an input money string. It is DOCUMENTATION only — the
// authority on what parses is parseMoneyToCents, invoked in the refinement
// below, so the schema can never accept something the money parser rejects (or
// vice versa). Duplicating the grammar as a validating regex is exactly the
// drift this task exists to remove.
const MONEY_INPUT_PATTERN = "^-?\\d+(\\.\\d{1,2})?$";

/**
 * A money amount on INPUT: a decimal string with at most two fractional
 * digits. Delegates to parseMoneyToCents so the error message a caller sees is
 * the money parser's own, unchanged from before this task.
 */
export const zMoney = z
  .string()
  .superRefine((value, ctx) => {
    try {
      parseMoneyToCents(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid money value.",
      });
    }
  })
  .meta({
    type: "string",
    pattern: MONEY_INPUT_PATTERN,
    examples: ["1250.00"],
    description:
      "KES amount as a decimal string with at most 2 decimal places. Stored as integer minor units (cents). Never send a JSON number — it is rejected.",
  });

/** Money on INPUT that may not be negative (prices, floats, tender amounts). */
export const zMoneyNonNegative = z
  .string()
  .superRefine((value, ctx) => {
    let cents: bigint;
    try {
      cents = parseMoneyToCents(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid money value.",
      });
      return;
    }
    if (cents < 0n) {
      ctx.addIssue({ code: "custom", message: "must not be negative." });
    }
  })
  .meta({
    type: "string",
    pattern: "^\\d+(\\.\\d{1,2})?$",
    examples: ["1250.00"],
    description:
      "Non-negative KES amount as a decimal string with at most 2 decimal places. Stored as integer minor units (cents). Never send a JSON number — it is rejected.",
  });

// Runtime money leaves a service as a bigint (Cents). A codec lets the wire
// contract (a string of cents) and the in-process type (bigint) be one schema:
// the OpenAPI document is generated from the INPUT side (a string), while
// response serialization ENCODES the bigint payload into that string. Strings
// are accepted on the payload side too, because a few reads build their totals
// as strings already.
const CENTS_WIRE = z.string().regex(/^-?\d+$/);

function encodeCents(value: bigint | string): string {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Money on OUTPUT: a string of integer minor units (KES cents), e.g. "125000". */
export const zCentsString = z
  .codec(
    CENTS_WIRE,
    z.custom<bigint | string>((v) => typeof v === "bigint" || typeof v === "string"),
    { decode: (s: string): bigint => BigInt(s), encode: encodeCents },
  )
  .meta({
    type: "string",
    pattern: "^-?\\d+$",
    examples: ["125000"],
    description:
      "Money as a string of integer minor units (KES cents). 125000 means KES 1,250.00. Never a JSON number: 2^53 and float coercion are both real hazards for an accounting API.",
  });

/** Nullable money on OUTPUT (e.g. a shift's closingFloat before it is counted). */
export const zCentsStringNullable = z
  .codec(
    CENTS_WIRE.nullable(),
    z.custom<bigint | string | null>(
      (v) => v === null || typeof v === "bigint" || typeof v === "string",
    ),
    {
      decode: (s: string | null): bigint | null => (s === null ? null : BigInt(s)),
      encode: (v: bigint | string | null): string | null => (v === null ? null : encodeCents(v)),
    },
  )
  .meta({
    type: "string",
    nullable: true,
    pattern: "^-?\\d+$",
    description:
      "Money as a string of integer minor units (KES cents), or null when not yet known.",
  });

// ---------------------------------------------------------------------------
// Quantities and rates — Decimal, NOT money. Never routed through the money
// parser (the engineering ledger, "Money Representation").
// ---------------------------------------------------------------------------

/** A quantity on INPUT: a Decimal(14,3) string. Validated by the inventory math parser. */
export const zQuantity = z
  .string()
  .superRefine((value, ctx) => {
    try {
      decimalToMilli(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid quantity.",
      });
    }
  })
  .meta({
    type: "string",
    pattern: "^-?\\d+(\\.\\d{1,3})?$",
    examples: ["2.500"],
    description:
      "Quantity as a Decimal(14,3) string. Never send a JSON number — it is rejected.",
  });

/** A quantity on INPUT that must be a positive magnitude (stock movements). */
export const zQuantityPositive = z
  .string()
  .superRefine((value, ctx) => {
    let milli: bigint;
    try {
      milli = decimalToMilli(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid quantity.",
      });
      return;
    }
    if (milli <= 0n) {
      ctx.addIssue({ code: "custom", message: "quantity must be a positive magnitude." });
    }
  })
  .meta({
    type: "string",
    pattern: "^\\d+(\\.\\d{1,3})?$",
    examples: ["2.500"],
    description:
      "Positive quantity as a Decimal(14,3) string. Never send a JSON number — it is rejected.",
  });

// A Decimal on OUTPUT arrives as a Prisma.Decimal instance or an already-built
// string; both render as the same string JSON.stringify would have produced.
function encodeDecimal(value: unknown): string {
  return String(value);
}

/** A quantity/rate on OUTPUT: a decimal string. */
export const zDecimalString = z
  .codec(z.string(), z.custom<unknown>((v) => v !== null && v !== undefined), {
    decode: (s: string): string => s,
    encode: encodeDecimal,
  })
  .meta({
    type: "string",
    examples: ["2.500"],
    description: "Decimal value as a string (quantity or percentage rate; never money).",
  });

/** A nullable quantity/rate on OUTPUT. */
export const zDecimalStringNullable = z
  .codec(z.string().nullable(), z.custom<unknown>(() => true), {
    decode: (s: string | null): string | null => s,
    encode: (v: unknown): string | null => (v === null || v === undefined ? null : encodeDecimal(v)),
  })
  .meta({
    type: "string",
    nullable: true,
    description: "Decimal value as a string, or null.",
  });

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** A calendar date on INPUT, YYYY-MM-DD, validated as a real date. */
export const zIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD.")
  .superRefine((value, ctx) => {
    if (isoDateToUtc(value) === null) {
      ctx.addIssue({ code: "custom", message: "must be YYYY-MM-DD." });
    }
  })
  .meta({
    type: "string",
    format: "date",
    examples: ["2026-08-05"],
    description: "Calendar date as YYYY-MM-DD (UTC).",
  });

/**
 * Convert a validated YYYY-MM-DD string to a UTC Date, or null if the calendar
 * date does not exist (e.g. 2026-02-31). The single date-parsing path — the
 * per-route copies of this function are gone.
 */
export function isoDateToUtc(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [ys, ms, ds] = value.split("-");
  if (ys === undefined || ms === undefined || ds === undefined) {
    return null;
  }
  const year = Number(ys);
  const month = Number(ms);
  const day = Number(ds);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * An INSTANT on input: a full ISO-8601 date-time. Distinct from zIsoDate, which
 * is a calendar DAY — an offline capture's businessTimestamp is a moment, not a
 * date, because the order sales happened in within a day is what fixes the order
 * they post in.
 */
export const zIsoDateTime = z
  .string()
  .superRefine((value, ctx) => {
    if (isoDateTimeToUtc(value) === null) {
      ctx.addIssue({
        code: "custom",
        message: "must be an ISO-8601 date-time, e.g. 2026-10-01T14:32:05.000Z.",
      });
    }
  })
  .meta({
    type: "string",
    format: "date-time",
    examples: ["2026-10-01T14:32:05.000Z"],
    description:
      "An instant as an ISO-8601 date-time with an EXPLICIT offset or Z. A timestamp with no zone is ambiguous, and near a month boundary the ambiguity decides which accounting period a sale lands in.",
  });

/**
 * Parse a validated ISO-8601 date-time into a Date, or null when it is not one.
 * The single instant-parsing path, as isoDateToUtc is for calendar dates.
 *
 * A bare date ("2026-10-01") is rejected, and so is a zone-less timestamp: an
 * instant must say WHEN and WHERE IN TIME. Reading a bare date as midnight UTC, or
 * a zone-less timestamp as the SERVER's local time, would put a sale in the wrong
 * business hour — and near a month boundary, in the wrong accounting period.
 */
export function isoDateTimeToUtc(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Today's BUSINESS date — the default "asOf" for point-in-time reports. Cut in the
 * business time zone (Task H.1), so a report run at 01:00 in Nairobi on the 1st is as
 * at the 1st, not the last day of the previous month.
 */
export function businessTodayDate(): Date {
  return businessToday();
}

/** A timestamp on OUTPUT: ISO-8601. Encodes a Date exactly as JSON.stringify did. */
export const zTimestamp = z.date().meta({
  type: "string",
  format: "date-time",
  description: "ISO-8601 timestamp (UTC).",
});

/** A nullable timestamp on OUTPUT. */
export const zTimestampNullable = z.date().nullable().meta({
  type: "string",
  format: "date-time",
  nullable: true,
  description: "ISO-8601 timestamp (UTC), or null.",
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

const DEFAULT_TAKE = 25;

/**
 * Pagination query. Coerced from the query string and CLAMPED rather than
 * rejected, preserving the pre-existing behaviour exactly: a non-integer or
 * out-of-range `take` silently falls back to the default instead of 400-ing.
 * Callers that need a different default pass one to zPaginationWithDefault.
 */
export function zPaginationWithDefault(defaultTake: number) {
  return z.object({
    take: z
      .string()
      .optional()
      .transform((raw) => clampTake(raw, defaultTake))
      .meta({
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: defaultTake,
        description: `Page size, 1-100. Out-of-range or non-integer values fall back to ${defaultTake}.`,
      }),
    skip: z
      .string()
      .optional()
      .transform(clampSkip)
      .meta({
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Rows to skip. Negative or non-integer values fall back to 0.",
      }),
  });
}

export const zPagination = zPaginationWithDefault(DEFAULT_TAKE);

/** The pagination block echoed on a list response. */
export const zPaginationResult = z.object({
  take: z.number().int(),
  skip: z.number().int(),
  total: z.number().int(),
});

function clampTake(raw: string | undefined, defaultTake: number): number {
  if (raw === undefined) {
    return defaultTake;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return defaultTake;
  }
  return Math.min(100, Math.max(1, n));
}

function clampSkip(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return 0;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** A path parameter carrying a resource id. */
export const zIdParam = z.object({
  id: z.string().min(1).meta({ description: "Resource id (uuid)." }),
});

/** A path parameter carrying an account code. */
export const zAccountCodeParam = z.object({
  code: z.string().min(1).meta({ description: "4-digit chart-of-accounts code.", examples: ["1010"] }),
});

// ---------------------------------------------------------------------------
// Errors — ONE documented error shape for the whole API
// ---------------------------------------------------------------------------

export const zError = z
  .object({
    statusCode: z.number().int().meta({ description: "HTTP status code." }),
    error: z.string().meta({ description: "Short machine-readable error class.", examples: ["BadRequest"] }),
    message: z.string().meta({ description: "Human-readable explanation." }),
  })
  .meta({ id: "Error", description: "Standard error response." });

export type ErrorBody = z.infer<typeof zError>;

/** Build the standard error body. The ONLY way an error body is constructed. */
export function errorBody(statusCode: number, error: string, message: string): ErrorBody {
  return { statusCode, error, message };
}

// Named constructors for the error classes the API actually emits, so a typo in
// an error name is a compile error rather than an undocumented response.
export const badRequest = (message: string): ErrorBody => errorBody(400, "BadRequest", message);
export const unauthorized = (message: string): ErrorBody => errorBody(401, "Unauthorized", message);
export const forbidden = (message: string): ErrorBody => errorBody(403, "Forbidden", message);
export const notFound = (message: string): ErrorBody => errorBody(404, "NotFound", message);
export const conflict = (message: string): ErrorBody => errorBody(409, "Conflict", message);

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 503;

/**
 * The documented error responses for a route. Spread into a route's `response`
 * map so every route documents the same shapes for the same codes:
 *   response: { 200: zThing, ...errorResponses(401, 403, 404) }
 * The literal status codes are preserved in the return type, so the type
 * provider still type-checks `reply.code(404).send(...)` against zError.
 */
export function errorResponses<const C extends readonly ErrorStatus[]>(
  ...codes: C
): { [K in C[number]]: typeof zError } {
  const responses = {} as { [K in C[number]]: typeof zError };
  for (const code of codes) {
    responses[code as C[number]] = zError;
  }
  return responses;
}

// ---------------------------------------------------------------------------
// OpenAPI tags & security
// ---------------------------------------------------------------------------

export const API_TAGS = [
  { name: "Health", description: "Liveness and database connectivity. Public." },
  { name: "Auth", description: "Login, refresh, logout, and the current session." },
  { name: "Products", description: "Product catalog (Module 2)." },
  { name: "Inventory", description: "Stock movements, valuation, transfers, suppliers (Module 2/4)." },
  {
    name: "Locations",
    description:
      "Selling locations and their per-location lease/session policy (Module 10). The policy is config this API stores; lease enforcement is the offline server task.",
  },
  {
    name: "Allocations",
    description:
      "Allocating stock to locations, the attendant-request / admin-approve workflow, and low-stock alerts (Module 10).",
  },
  { name: "Ledger", description: "Double-entry general ledger, trial balance, periods (Module 5)." },
  { name: "POS", description: "Shifts, sales, receipts, voids (Module 3)." },
  { name: "Customers", description: "Customers and store credit (Module 6)." },
  { name: "M-Pesa", description: "STK Push, transaction status, and the public Safaricom callback (Module 3)." },
  { name: "Integrations", description: "Per-tenant encrypted provider credentials and go-live settings (Task 3.4)." },
  {
    name: "Procurement",
    description:
      "Purchase orders and goods receipts (Module 4). A receipt accrues what is owed to 2050 GRNI — goods arrive with a delivery note, not a tax invoice — and the supplier bill that clears it to Accounts Payable is under Payables.",
  },
  {
    name: "Payables",
    description:
      "Supplier bills, payments and AP aging (Module 7). A bill is the INVOICE side of procurement: it clears 2050 GRNI at the price the receipt accrued, recognises recoverable input VAT in 1400 (only now — a VAT claim needs a tax invoice), posts any difference between accrued and invoiced price to 5250 Purchase Price Variance, and credits 2000 Accounts Payable. It never writes a stock table and never touches account 1200: a bill changes what is OWED, not what is HELD.",
  },
  {
    name: "Receivables",
    description:
      "Customer receipts, allocation, AR aging and statements (Module 6). A CREDIT SALE ALREADY IS the receivable: the till posted Dr 1100 / Cr revenue (+ output VAT) and raised the customer's balance, so there is no invoice to create, no VAT to recognise and no price variance here. This is the money coming BACK: Dr cash|bank|M-Pesa / Cr 1100, allocated against specific credit sales. It touches no revenue account and no stock table.",
  },
  {
    name: "Payroll",
    description:
      "Employees, the effective-dated Kenyan statutory ruleset, the gross-to-net engine and the monthly payroll accrual (Module 8). **No statutory rate is a constant in code** — PAYE bands, NSSF limits, the SHIF rate and the housing levy all live in a dated `StatutorySchedule` that a run records, so a run for a past period stays correct against the rates in force then. Posting books ONE balanced accrual: gross to 6020, the employer's matched contributions to 6025, each statutory head to its own liability and net pay to 2120. It touches no stock table, never posts to 1200 and never touches revenue. SETTLEMENT (Task 8.2) pays the net out of 2120 and remits each statutory head — liability to cash, nothing else — and the filing routes produce the payslip document, the PAYE (P10 shape) / NSSF / SHIF / Housing Levy schedules and the muster roll, each tied to the payslips and to the ledger.",
  },
  {
    name: "Settings",
    description:
      "Per-tenant business configuration: the tax regime and VAT status that decide how a purchase receipt splits cost from recoverable input VAT, and the home for the statutory flags payroll and reporting will extend.",
  },
  {
    name: "eTIMS",
    description:
      "KRA eTIMS OSCU fiscal signing (Module 9). OPT-IN PER SALE and the minority case: most MSME sales are informal and are validly finalized with no fiscal invoice. Each tenant files under THEIR OWN KRA PIN and OSCU device credentials — Angaza is never the integrator and there is no shared signer. Signing is post-commit and posts nothing to the ledger.",
  },
  {
    name: "Offline",
    description:
      "Offline devices, custody (lease start/renew/end), the sync ingest endpoint that replays captured sales through the real atomic sale transaction, frozen-allocation state, and the admin write-off (Task OFF.1).",
  },
  {
    name: "Mentorship",
    description:
      "Mentorship & coaching (Module 14). Engagements are created by an admin, CONSENTED to by the business owner, and ended by any party. A mentor reads a business's figures ONLY through an ACTIVE engagement: the business is resolved from the engagement record — never from the request — every read runs READ ONLY through the Module 13 engine, and every read is logged for the owner to see.",
  },
  {
    name: "Reports",
    description:
      "Financial statements and reporting (Module 13): income statement, balance sheet, indirect cash flow, trial balance, VAT return / TOT position, and the control-account reconciliation. READ-ONLY — derived from posted journal lines through the ledger's one balance query, ranged by entryDate (never createdAt), each statement asserting its own identity.",
  },
] as const;

/** The name of the registered bearer scheme. Routes reference it by this key. */
export const BEARER_SCHEME = "bearerAuth";

/** Attach to a route that requires an authenticated session. */
export const SECURE = [{ [BEARER_SCHEME]: [] }];

/** Attach to a route that is deliberately public (documents "no auth needed"). */
export const PUBLIC: never[] = [];
