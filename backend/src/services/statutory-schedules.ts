// ===========================================================================
// THE STATUTORY RULESET — SEEDER (Task 8.1) AND SUPERSEDING VERSIONS (Task 3B.3).
//
// THIS FILE IS THE ONLY WRITER OF `statutory_schedules` AND `paye_bands`: the
// platform-run seeder below, and `supersedeStatutorySchedule` at the end of the file.
//
// REVISED BY TASK 3B.3: the "not user-writable" stance described next was 8.1's. Rates
// are now TENANT-EDITABLE by the MSME_OWNER — but only by SUPERSEDING: a change is a
// NEW effective-dated version from a commencement date, and the currently-open version
// is closed at that date. A version any transaction has used is never mutated, so
// history stays exactly as it was filed. The seeder still sets the verified national
// defaults at provisioning. The original 8.1 rationale is kept below for the record.
//
// This is the SINGLE SOURCE of every payroll rate in the system, and it is DATA
// rather than code: nothing here is read as a constant by the engine, which takes a
// resolved `StatutorySchedule` ROW and computes from its columns.
//
// WHY A SEEDER BESIDE `seedChartOfAccounts` AND NOT AN API:
//
// A statutory figure is not tenant configuration — it is the law of Kenya. Every
// MSME on this platform must compute February 2026 on the SAME bands, or two
// businesses file different PAYE for the same salary. So the ruleset arrives by the
// SAME PLATFORM-RUN MECHANISM AS THE CHART OF ACCOUNTS — provisioning for a new
// tenant, the per-tenant migration runner for existing ones — and a statutory update
// is ONE dated operation across all of them, never a per-tenant edit.
//
// That is also why `/v1/payroll/statutory-schedules` is READ-ONLY. There is no route
// that writes a rate. The engineering ledger "Configurable Statutory & Regulatory Values" requires
// the figures to be tenant-ADJUSTABLE with effective-date versioning rather than
// hardcoded; the versioning is here and real, while the adjustment is an
// administrator's dated deployment rather than an owner's text box — because an owner
// mistyping the NSSF ceiling would silently mis-file for every employee.
//
// ---------------------------------------------------------------------------
// HOW TO ADD THE NEXT SCHEDULE (read this before changing a number)
//
// DO NOT EDIT THE ROW BELOW. Add a NEW entry with its own label and
// `effectiveFrom`, and CLOSE the previous one by setting its `effectiveTo` to the
// same date. A payroll run records which schedule computed it, so editing a rate
// already used would make posted payslips unreproducible — and migration 0021's
// `statutory_schedule_guard` refuses exactly that.
//
// Then VERIFY THE FIGURES AGAINST AN AUTHORITATIVE SOURCE and record the citation
// and the date in `source` / `verifiedOn`. The engineering ledger makes this standing law, and
// the `statutory_schedule_source_recorded` CHECK makes a blank citation impossible.
// Do not copy numbers forward on trust: the TechSpec's appendix is known to be stale.
// ===========================================================================

import type { PoolClient } from "pg";
import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import type { Cents } from "../lib/money";
import { businessToday } from "../lib/business-time";

export interface SeedPayeBand {
  readonly id: string;
  readonly ordinal: number;
  /** Cents of monthly taxable pay. The band is `[lowerBound, upperBound)`. */
  readonly lowerBound: string;
  /** NULL means the top band — unbounded above. */
  readonly upperBound: string | null;
  /** A RATE as a decimal percentage string, never money. */
  readonly ratePercent: string;
}

export interface SeedStatutorySchedule {
  readonly id: string;
  readonly label: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly source: string;
  readonly verifiedOn: string;
  readonly notes: string;
  /** All money figures are strings of KES cents, parsed to BigInt by the driver. */
  readonly personalRelief: string;
  readonly nssfRatePercent: string;
  readonly nssfLowerLimit: string;
  readonly nssfUpperLimit: string;
  readonly shifRatePercent: string;
  readonly shifMinimum: string;
  readonly ahlRatePercent: string;
  /** The national standard VAT rate (Task 3B.1) — a RATE as a decimal string. */
  readonly vatStandardRate: string;
  readonly vatRateSource: string;
  readonly vatRateVerifiedOn: string;
  /** The Turnover Tax rate (Task 3B.2) — a RATE on gross turnover, as a decimal string. */
  readonly totRatePercent: string;
  readonly totRateSource: string;
  readonly totRateVerifiedOn: string;
  readonly bands: readonly SeedPayeBand[];
}

/**
 * THE KENYAN STATUTORY RULESET IN FORCE FROM FEBRUARY 2026.
 *
 * FIGURES VERIFIED 2026-10-04 against the sources in `source` below:
 *
 *   Personal relief   KES 2,400.00 per month (KES 28,800 per annum)
 *   NSSF              6% employee + 6% MATCHED employer, LEL KES 9,000,
 *                     UEL KES 108,000 — NSSF Act 2013 "Year Four", effective
 *                     February 2026. Maximum KES 6,480 each side.
 *   SHIF              2.75% of GROSS, minimum KES 300 per month, NO upper cap —
 *                     Social Health Authority, replacing NHIF from October 2024.
 *   Housing Levy      1.5% employee + 1.5% MATCHED employer.
 *   PAYE              10% to 24,000 · 25% to 32,333 · 30% to 500,000 ·
 *                     32.5% to 800,000 · 35% above.
 *
 * The window opens on 2026-02-01 because that is when the NSSF Year Four limits
 * took effect. The PAYE bands, the relief, SHIF and AHL were already in force before
 * then — February is simply the date the COMBINED ruleset last changed, and a
 * schedule describes a combination rather than any one figure.
 *
 * THE DEDUCTIBILITY TREATMENT IS THE LOAD-BEARING PART. Under the Tax Laws
 * (Amendment) Act 2024, effective 27 December 2024, NSSF, SHIF and AHL are ALLOWABLE
 * DEDUCTIONS against taxable pay — they reduce the income PAYE is computed on. They
 * are NOT reliefs against the tax, which is what they used to be. Getting that
 * backwards changes the answer for every employee, so the engine applies them before
 * the bands and `payroll-math.ts` says so where it does it.
 */
export const STATUTORY_SCHEDULE_SEEDS: readonly SeedStatutorySchedule[] = [
  {
    id: "00000000-0000-4000-8000-000000210001",
    label: "KE-2026-02",
    effectiveFrom: "2026-02-01",
    effectiveTo: null,
    source:
      "NSSF Act 2013 Year Four limits (LEL 9,000 / UEL 108,000, 6% matched) effective Feb 2026; " +
      "Social Health Insurance Fund 2.75% of gross with a KES 300 monthly minimum and no cap (SHA, replacing NHIF from Oct 2024); " +
      "Affordable Housing Levy 1.5% employee + 1.5% employer; " +
      "PAYE bands and KES 2,400/month personal relief per the Income Tax Act as amended by the Finance Act 2023; " +
      "NSSF, SHIF and AHL treated as ALLOWABLE DEDUCTIONS against taxable pay per the Tax Laws (Amendment) Act 2024, effective 27 December 2024. " +
      "Verified 2026-10-04.",
    verifiedOn: "2026-10-04",
    notes:
      "Monthly salaried employees only. The Tax Laws (Amendment) Act 2024 changed NSSF, SHIF and AHL from reliefs against tax to allowable deductions against taxable pay — the engine applies them before the bands, which is what makes the deduction order load-bearing rather than cosmetic.",
    personalRelief: "240000",
    nssfRatePercent: "6.00",
    nssfLowerLimit: "900000",
    nssfUpperLimit: "10800000",
    shifRatePercent: "2.75",
    shifMinimum: "30000",
    ahlRatePercent: "1.50",
    // VERIFIED 2026-10-11 against the statute and KRA (Task 3B.1). Recorded separately
    // from the payroll `source` because it was verified on a different day.
    vatStandardRate: "16.00",
    vatRateSource:
      "VAT Act No. 35 of 2013, s.5(2)(b): the standard rate is 16% of the taxable value of a taxable supply (KRA, kra.go.ke — Value Added Tax). " +
      "Zero-rated supplies (Second Schedule) 0%; exempt supplies (First Schedule) outside VAT. " +
      "A 2026 budget proposal to reduce the rate to 15% was not enacted as at verification. Verified 2026-10-11.",
    vatRateVerifiedOn: "2026-10-11",
    // RECORDED 2026-10-11 (Task 3B.2), with an OPEN DISCREPANCY kept in the citation
    // rather than resolved by assumption — see the source text and the engineering ledger "Turnover Tax".
    totRatePercent: "3.00",
    totRateSource:
      "Income Tax Act (Cap. 470) s.12C and Third Schedule as amended by the Finance Act 2023: Turnover Tax 3% of gross turnover (raised from 1%), effective 1 July 2023, for resident persons with business turnover above KES 1,000,000 and not above KES 25,000,000. " +
      "Corroborated by PwC Tax Summaries (Kenya, 2026); no later amending Act found (Tax Laws (Amendment) Act 2024, Tax Procedures (Amendment) Act 2024 and Finance Act 2025 do not amend TOT). " +
      "OPEN DISCREPANCY: KRA's TOT web page states 1.5% \"as per Finance Act 2023\", contradicting that Act; gazetted text not reachable at verification. Verified 2026-10-11.",
    totRateVerifiedOn: "2026-10-11",
    bands: [
      { id: "00000000-0000-4000-8000-000000210101", ordinal: 1, lowerBound: "0", upperBound: "2400000", ratePercent: "10.00" },
      { id: "00000000-0000-4000-8000-000000210102", ordinal: 2, lowerBound: "2400000", upperBound: "3233300", ratePercent: "25.00" },
      { id: "00000000-0000-4000-8000-000000210103", ordinal: 3, lowerBound: "3233300", upperBound: "50000000", ratePercent: "30.00" },
      { id: "00000000-0000-4000-8000-000000210104", ordinal: 4, lowerBound: "50000000", upperBound: "80000000", ratePercent: "32.50" },
      { id: "00000000-0000-4000-8000-000000210105", ordinal: 5, lowerBound: "80000000", upperBound: null, ratePercent: "35.00" },
    ],
  },
];

/**
 * Seed every known statutory schedule into a tenant schema. Returns how many
 * schedule rows were inserted.
 *
 * IDEMPOTENT, keyed on `label` and on `(scheduleId, ordinal)`, so a tenant that
 * already has the ruleset adds zero — which is what lets it be called from BOTH
 * provisioning and the per-tenant migration runner, exactly as
 * `seedChartOfAccounts` is. The ids are FIXED rather than generated for the same
 * reason: re-running must not create a second copy under a new key.
 *
 * The bands are inserted inside the caller's transaction, which matters: migration
 * 0021's `paye_bands_contiguous_check` is DEFERRED, so the ladder is validated once
 * at COMMIT rather than refusing the first band for not yet having its siblings.
 */
export async function seedStatutorySchedule(
  client: PoolClient,
  schema: string,
): Promise<number> {
  assertValidSchemaName(schema);

  let inserted = 0;
  for (const schedule of STATUTORY_SCHEDULE_SEEDS) {
    const result = await client.query(
      `INSERT INTO "${schema}"."statutory_schedules"
         ("id", "label", "effectiveFrom", "effectiveTo", "source", "verifiedOn", "notes",
          "personalRelief", "nssfRatePercent", "nssfLowerLimit", "nssfUpperLimit",
          "shifRatePercent", "shifMinimum", "ahlRatePercent",
          "vatStandardRate", "vatRateSource", "vatRateVerifiedOn",
          "totRatePercent", "totRateSource", "totRateVerifiedOn", "createdAt")
       VALUES
         ($1, $2, $3::date, $4::date, $5, $6::date, $7,
          $8::bigint, $9::numeric, $10::bigint, $11::bigint,
          $12::numeric, $13::bigint, $14::numeric,
          $15::numeric, $16, $17::date,
          $18::numeric, $19, $20::date, now())
       ON CONFLICT ("label") DO NOTHING`,
      [
        schedule.id,
        schedule.label,
        schedule.effectiveFrom,
        schedule.effectiveTo,
        schedule.source,
        schedule.verifiedOn,
        schedule.notes,
        schedule.personalRelief,
        schedule.nssfRatePercent,
        schedule.nssfLowerLimit,
        schedule.nssfUpperLimit,
        schedule.shifRatePercent,
        schedule.shifMinimum,
        schedule.ahlRatePercent,
        schedule.vatStandardRate,
        schedule.vatRateSource,
        schedule.vatRateVerifiedOn,
        schedule.totRatePercent,
        schedule.totRateSource,
        schedule.totRateVerifiedOn,
      ],
    );
    inserted += result.rowCount ?? 0;

    for (const band of schedule.bands) {
      await client.query(
        `INSERT INTO "${schema}"."paye_bands"
           ("id", "scheduleId", "ordinal", "lowerBound", "upperBound", "ratePercent")
         VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6::numeric)
         ON CONFLICT ("scheduleId", "ordinal") DO NOTHING`,
        [band.id, schedule.id, band.ordinal, band.lowerBound, band.upperBound, band.ratePercent],
      );
    }
  }

  return inserted;
}

// ===========================================================================
// SUPERSEDING A VERSION (Task 3B.3) — the ONE way a statutory rate changes.
//
// SUPERSEDE-FORWARD, NEVER MUTATE-IN-PLACE. A new version is a COMPLETE ruleset — every
// scalar rate and the full PAYE band ladder — from a commencement date; in ONE
// transaction the currently-open version's window is closed at that date and the new
// version is inserted. Because windows are half-open [effectiveFrom, effectiveTo),
// "closed to the day before" is stored as `effectiveTo = new effectiveFrom`: the old
// version's last day is the day before, and no day is left without a schedule.
//
// THE COMMENCEMENT DATE MUST BE AFTER EVERYTHING THE OPEN VERSION GOVERNED: strictly
// after its own start, after the latest journal entry dated inside it (sales, bills,
// receipts and payroll accruals all resolve their rates by date), and after the period
// start of every live payroll run computed under it. So no posted transaction ever
// changes which version governed it. The schedule guard (migration 0026) enforces the
// same rule in the database; this is the ergonomic half with a clear message.
// ===========================================================================

/** Bad input — a blank citation, an out-of-range rate, a broken band ladder. Route -> 400. */
export class StatutoryConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatutoryConfigValidationError";
  }
}

/** The request conflicts with existing versions or posted transactions. Route -> 409. */
export class StatutoryConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatutoryConfigConflictError";
  }
}

export interface SupersedeBandInput {
  lowerBound: Cents;
  upperBound: Cents | null;
  ratePercent: string;
}

export interface SupersedeScheduleInput {
  /** Defaults to "KE-<effectiveFrom>". Unique across versions. */
  label?: string;
  /** A business date (00:00 UTC). The first day the new version governs. */
  effectiveFrom: Date;
  source: string;
  verifiedOn: Date;
  notes?: string;
  personalRelief: Cents;
  nssfRatePercent: string;
  nssfLowerLimit: Cents;
  nssfUpperLimit: Cents;
  shifRatePercent: string;
  shifMinimum: Cents;
  ahlRatePercent: string;
  vatStandardRate: string;
  vatRateSource: string;
  vatRateVerifiedOn: Date;
  totRatePercent: string;
  totRateSource: string;
  totRateVerifiedOn: Date;
  bands: SupersedeBandInput[];
  createdById: string;
}

const RATE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

/** A percentage as hundredths of a percent, compared without floating point. */
function rateHundredths(field: string, rate: string): bigint {
  const trimmed = rate.trim();
  if (!RATE_PATTERN.test(trimmed)) {
    throw new StatutoryConfigValidationError(`${field} must be a percentage as a decimal string with at most two decimal places, e.g. "16.00". It is a RATE, not money.`);
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  const value = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  if (value > 10000n) {
    throw new StatutoryConfigValidationError(`${field} must be between 0 and 100 percent (got ${trimmed}).`);
  }
  return value;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function validateSupersede(input: SupersedeScheduleInput): void {
  for (const [field, text] of [
    ["source", input.source],
    ["vatRateSource", input.vatRateSource],
    ["totRateSource", input.totRateSource],
  ] as const) {
    if (text.trim() === "") {
      throw new StatutoryConfigValidationError(`${field} is required: every statutory figure must cite where it came from (the engineering ledger "Configurable Statutory & Regulatory Values").`);
    }
  }
  const today = businessToday();
  for (const [field, date] of [
    ["verifiedOn", input.verifiedOn],
    ["vatRateVerifiedOn", input.vatRateVerifiedOn],
    ["totRateVerifiedOn", input.totRateVerifiedOn],
  ] as const) {
    if (date > today) {
      throw new StatutoryConfigValidationError(`${field} (${iso(date)}) is in the future: a figure cannot have been verified on a day that has not happened.`);
    }
  }
  for (const [field, rate] of [
    ["nssfRatePercent", input.nssfRatePercent],
    ["shifRatePercent", input.shifRatePercent],
    ["ahlRatePercent", input.ahlRatePercent],
  ] as const) {
    rateHundredths(field, rate);
  }
  for (const [field, rate] of [
    ["vatStandardRate", input.vatStandardRate],
    ["totRatePercent", input.totRatePercent],
  ] as const) {
    if (rateHundredths(field, rate) === 0n) {
      throw new StatutoryConfigValidationError(`${field} must be greater than 0: a zero standard rate is not a rate (zero-rated and exempt supplies are tax CLASSES).`);
    }
  }
  for (const [field, amount] of [
    ["personalRelief", input.personalRelief],
    ["nssfLowerLimit", input.nssfLowerLimit],
    ["shifMinimum", input.shifMinimum],
  ] as const) {
    if (amount < 0n) {
      throw new StatutoryConfigValidationError(`${field} must not be negative.`);
    }
  }
  if (input.nssfUpperLimit <= input.nssfLowerLimit) {
    throw new StatutoryConfigValidationError("nssfUpperLimit must be greater than nssfLowerLimit: the lower limit is the Tier I / Tier II boundary below the ceiling.");
  }

  // THE PAYE LADDER: a contiguous, ascending partition of taxable pay from zero with
  // exactly one open-topped band, at the top. The deferred DB trigger (0021) refuses
  // anything else at COMMIT; this names the defect first.
  const bands = input.bands;
  if (bands.length === 0) {
    throw new StatutoryConfigValidationError("A schedule needs its PAYE bands: there is no ladder to compute tax on.");
  }
  bands.forEach((band, index) => {
    const label = `bands[${index.toString()}]`;
    rateHundredths(`${label}.ratePercent`, band.ratePercent);
    if (band.lowerBound < 0n) {
      throw new StatutoryConfigValidationError(`${label}.lowerBound must not be negative.`);
    }
    if (index === 0 && band.lowerBound !== 0n) {
      throw new StatutoryConfigValidationError("The first PAYE band must start at 0: every shilling of taxable pay has to fall in a band.");
    }
    const isLast = index === bands.length - 1;
    if (band.upperBound === null && !isLast) {
      throw new StatutoryConfigValidationError(`${label} is open-topped but is not the last band: only the top band may be unbounded.`);
    }
    if (band.upperBound !== null && isLast) {
      throw new StatutoryConfigValidationError("The last PAYE band must be open-topped (upperBound null): pay above it would fall in no band.");
    }
    if (band.upperBound !== null && band.upperBound <= band.lowerBound) {
      throw new StatutoryConfigValidationError(`${label}: upperBound must be greater than lowerBound.`);
    }
    const previous = index > 0 ? bands[index - 1] : undefined;
    if (previous !== undefined && previous.upperBound !== band.lowerBound) {
      throw new StatutoryConfigValidationError(`PAYE bands are not contiguous: ${label} starts at ${band.lowerBound.toString()} but the band below it ends at ${previous.upperBound === null ? "unbounded" : previous.upperBound.toString()}. A gap would tax nothing in it; an overlap would tax the same shillings twice.`);
    }
  });
}

/**
 * Create a NEW version superseding the currently-open one. Returns the new version's id.
 *
 * Refuses (409) when the commencement date is not after everything the open version
 * governed, or the label is taken; refuses (400) on any malformed figure. Writes NOTHING
 * else: no sale, run, journal entry or balance is touched, and nothing is recomputed —
 * every posted transaction keeps the rate that governed it.
 */
export async function supersedeStatutorySchedule(
  db: TenantPrismaClient,
  input: SupersedeScheduleInput,
): Promise<string> {
  validateSupersede(input);
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  const label = (input.label ?? `KE-${iso(input.effectiveFrom)}`).trim();
  if (label === "") {
    throw new StatutoryConfigValidationError("label must not be blank.");
  }

  return db.$transaction(async (tx) => {
    // Serialise concurrent supersessions on the open version.
    const open = await tx.$queryRawUnsafe<Array<{ id: string; label: string; effectiveFrom: Date }>>(
      `SELECT "id", "label", "effectiveFrom" FROM "${schema}".statutory_schedules
        WHERE "effectiveTo" IS NULL FOR UPDATE`,
    );
    const current = open[0];
    if (current === undefined || open.length !== 1) {
      throw new StatutoryConfigConflictError(
        `There must be exactly one open-ended statutory schedule to supersede; found ${open.length.toString()}.`,
      );
    }
    if (input.effectiveFrom <= current.effectiveFrom) {
      throw new StatutoryConfigConflictError(
        `effectiveFrom ${iso(input.effectiveFrom)} must be AFTER the start of the latest open-ended version (${current.label}, from ${iso(current.effectiveFrom)}). Versions are superseded forward along the chain, never rewritten or inserted behind the latest.`,
      );
    }

    const latest = await tx.$queryRawUnsafe<Array<{ entry: Date | null; run: Date | null }>>(
      `SELECT (SELECT max("entryDate") FROM "${schema}".journal_entries WHERE "entryDate" >= $1) AS entry,
              (SELECT max(make_date("periodYear", "periodMonth", 1)) FROM "${schema}".payroll_runs
                WHERE "statutoryScheduleId" = $2 AND "status"::text <> 'CANCELLED') AS run`,
      current.effectiveFrom,
      current.id,
    );
    const lastEntry = latest[0]?.entry ?? null;
    const lastRun = latest[0]?.run ?? null;
    if (lastEntry !== null && input.effectiveFrom <= lastEntry) {
      throw new StatutoryConfigConflictError(
        `effectiveFrom ${iso(input.effectiveFrom)} is on or before ${iso(lastEntry)}, the latest transaction already posted under ${current.label}. Those transactions keep the rates that governed them; supersede from a date after ${iso(lastEntry)}.`,
      );
    }
    if (lastRun !== null && input.effectiveFrom <= lastRun) {
      throw new StatutoryConfigConflictError(
        `effectiveFrom ${iso(input.effectiveFrom)} is on or before ${iso(lastRun)}, the period start of a payroll run computed under ${current.label}. Supersede from a date after it.`,
      );
    }

    const taken = await tx.statutorySchedule.findUnique({ where: { label }, select: { id: true } });
    if (taken !== null) {
      throw new StatutoryConfigConflictError(`A statutory schedule labelled "${label}" already exists; give the new version its own label.`);
    }

    // Close the open version AT the commencement date (half-open: its last day is the
    // day before), THEN insert — the no-overlap exclusion is checked immediately.
    await tx.statutorySchedule.update({
      where: { id: current.id },
      data: { effectiveTo: input.effectiveFrom },
    });

    const created = await tx.statutorySchedule.create({
      data: {
        label,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        source: input.source.trim(),
        verifiedOn: input.verifiedOn,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        personalRelief: input.personalRelief,
        nssfRatePercent: input.nssfRatePercent.trim(),
        nssfLowerLimit: input.nssfLowerLimit,
        nssfUpperLimit: input.nssfUpperLimit,
        shifRatePercent: input.shifRatePercent.trim(),
        shifMinimum: input.shifMinimum,
        ahlRatePercent: input.ahlRatePercent.trim(),
        vatStandardRate: input.vatStandardRate.trim(),
        vatRateSource: input.vatRateSource.trim(),
        vatRateVerifiedOn: input.vatRateVerifiedOn,
        totRatePercent: input.totRatePercent.trim(),
        totRateSource: input.totRateSource.trim(),
        totRateVerifiedOn: input.totRateVerifiedOn,
        createdById: input.createdById,
        bands: {
          create: input.bands.map((band, index) => ({
            ordinal: index + 1,
            lowerBound: band.lowerBound,
            upperBound: band.upperBound,
            ratePercent: band.ratePercent.trim(),
          })),
        },
      },
      select: { id: true },
    });
    return created.id;
  });
}
