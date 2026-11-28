// ===========================================================================
// BUSINESS TIME — the ONE place an instant becomes a business calendar day (Task H.1).
//
// Two kinds of time live in this system and they must never be confused:
//
//   * INSTANTS — when something happened: `createdAt`, `businessTimestamp`,
//     `receivedAt`, `new Date()`. Stored as `timestamptz`, unambiguous, UTC.
//   * BUSINESS DATES — which accounting day something belongs to: `entryDate`,
//     `billDate`, `payDate`, `receiptDate`, `remittanceDate`. Stored as `date`.
//
// Turning the first into the second is a decision about WHERE the business is, not a
// property of the instant. A sale rung at 01:30 in Nairobi on 1 November is a
// NOVEMBER sale, even though it is still 31 October in UTC. Cutting the day in UTC
// would post it to October — the wrong day, and on a month boundary the wrong
// accounting period, which a financial statement then reports in the wrong month.
//
// So every instant -> day cut in the codebase goes through `businessDateOf`, and the
// zone is named ONCE, here. There is no second "+3 hours" anywhere.
//
// A business date is REPRESENTED in JS as the Date at 00:00:00.000 UTC of that
// calendar day — the same representation `isoDateToUtc("2026-11-01")` produces and
// Prisma reads from a `@db.Date` column — so dates arriving from a request and dates
// cut from an instant are interchangeable and compare correctly.
//
// WHY A DATE THAT IS ALREADY A BUSINESS DATE SURVIVES A SECOND CUT: Africa/Nairobi is
// UTC+3 with no daylight saving, so 00:00 UTC of day D is 03:00 on day D in Nairobi —
// the same calendar day. `businessDateOf(businessDateOf(x)) == businessDateOf(x)`,
// which is what lets the ledger normalise every `entryDate` it receives without
// knowing whether the caller passed an instant or a date. That property holds for any
// zone at or east of UTC; `assertBusinessZoneEastOfUtc` refuses to load otherwise,
// because a zone west of UTC would silently shift every date-only input back a day.
// ===========================================================================

/**
 * The ONE platform time zone in which every tenant's accounting day is cut.
 * Future per-tenant plug: `BusinessProfile.timezone` (not added — every tenant today is Kenyan).
 */
export const BUSINESS_TIMEZONE = "Africa/Nairobi";

const MS_PER_MINUTE = 60_000;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const part = parts.find((p) => p.type === type);
  if (part === undefined) {
    throw new Error(`Intl.DateTimeFormat returned no "${type}" part for ${BUSINESS_TIMEZONE}.`);
  }
  return Number.parseInt(part.value, 10);
}

/** The wall-clock reading of an instant in the business time zone. */
export function businessDateTimeParts(instant: Date): ZonedParts {
  const parts = formatter.formatToParts(instant);
  return {
    year: partValue(parts, "year"),
    month: partValue(parts, "month"),
    day: partValue(parts, "day"),
    hour: partValue(parts, "hour"),
    minute: partValue(parts, "minute"),
    second: partValue(parts, "second"),
  };
}

/**
 * THE BUSINESS CALENDAR DAY an instant falls on, as 00:00 UTC of that day.
 *
 *     businessDateOf(2026-10-31T22:30:00Z)  ->  2026-11-01   (01:30 in Nairobi)
 *     businessDateOf(2026-11-01T00:00:00Z)  ->  2026-11-01   (a date stays itself)
 */
export function businessDateOf(instant: Date): Date {
  const p = businessDateTimeParts(instant);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

/** Today's business date. */
export function businessToday(now: Date = new Date()): Date {
  return businessDateOf(now);
}

/**
 * The INSTANT a business calendar day begins — midnight in the business zone,
 * expressed in UTC. For Nairobi, the 1st of November begins at 21:00 UTC on 31
 * October. Used wherever an instant is compared with a period boundary, so that
 * "inside November" means inside November where the business is.
 */
export function businessDayStart(year: number, month: number, day: number): Date {
  const asIfUtc = Date.UTC(year, month - 1, day);
  // The zone's offset at that moment: how far its wall clock reads ahead of UTC.
  const p = businessDateTimeParts(new Date(asIfUtc));
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = wallAsUtc - asIfUtc;
  return new Date(asIfUtc - offsetMs);
}

/** The exclusive end of accounting period `year`-`month`: the instant the next month begins. */
export function businessPeriodEndExclusive(year: number, month: number): Date {
  return month === 12 ? businessDayStart(year + 1, 1, 1) : businessDayStart(year, month + 1, 1);
}

/**
 * Refuse to run in a zone west of UTC, where a date-only input (00:00 UTC) would read
 * as the PREVIOUS day and every request date would silently shift. Evaluated at load.
 */
function assertBusinessZoneEastOfUtc(): void {
  const probe = Date.UTC(2026, 0, 1);
  const p = businessDateTimeParts(new Date(probe));
  const offsetMinutes = (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - probe) / MS_PER_MINUTE;
  if (offsetMinutes < 0) {
    throw new Error(
      `BUSINESS_TIMEZONE ${BUSINESS_TIMEZONE} is west of UTC (offset ${offsetMinutes.toString()} min). Date-only inputs are represented as 00:00 UTC and would read as the previous business day there; the date representation must change before such a zone is supported.`,
    );
  }
}

assertBusinessZoneEastOfUtc();
