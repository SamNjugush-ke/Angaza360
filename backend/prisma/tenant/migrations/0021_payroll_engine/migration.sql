-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('PERMANENT', 'CONTRACT', 'CASUAL');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "EmployeePaymentMethod" AS ENUM ('CASH', 'BANK', 'MPESA');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'POSTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "statutory_schedules" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "source" TEXT NOT NULL,
    "verifiedOn" DATE NOT NULL,
    "notes" TEXT,
    "personalRelief" BIGINT NOT NULL,
    "nssfRatePercent" DECIMAL(5,2) NOT NULL,
    "nssfLowerLimit" BIGINT NOT NULL,
    "nssfUpperLimit" BIGINT NOT NULL,
    "shifRatePercent" DECIMAL(5,2) NOT NULL,
    "shifMinimum" BIGINT NOT NULL,
    "ahlRatePercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statutory_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paye_bands" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "lowerBound" BIGINT NOT NULL,
    "upperBound" BIGINT,
    "ratePercent" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "paye_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "employeeNumber" INTEGER NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "nationalId" TEXT,
    "kraPin" TEXT,
    "nssfNumber" TEXT,
    "shifNumber" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'PERMANENT',
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "hireDate" DATE NOT NULL,
    "terminationDate" DATE,
    "basicSalary" BIGINT NOT NULL,
    "paymentMethod" "EmployeePaymentMethod" NOT NULL DEFAULT 'BANK',
    "bankName" TEXT,
    "bankAccount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_allowances" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "employee_allowances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "payDate" DATE NOT NULL,
    "statutoryScheduleId" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "grossPay" BIGINT NOT NULL,
    "taxableGross" BIGINT NOT NULL,
    "nssfEmployee" BIGINT NOT NULL,
    "nssfEmployer" BIGINT NOT NULL,
    "nssfTier1" BIGINT NOT NULL,
    "nssfTier2" BIGINT NOT NULL,
    "shifEmployee" BIGINT NOT NULL,
    "ahlEmployee" BIGINT NOT NULL,
    "ahlEmployer" BIGINT NOT NULL,
    "taxablePay" BIGINT NOT NULL,
    "payeBeforeRelief" BIGINT NOT NULL,
    "personalReliefApplied" BIGINT NOT NULL,
    "paye" BIGINT NOT NULL,
    "totalEmployeeDeductions" BIGINT NOT NULL,
    "netPay" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_earnings" (
    "id" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "taxable" BOOLEAN NOT NULL,

    CONSTRAINT "payslip_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "statutory_schedules_label_key" ON "statutory_schedules"("label");

-- CreateIndex
CREATE INDEX "statutory_schedules_effectiveFrom_idx" ON "statutory_schedules"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "paye_bands_scheduleId_ordinal_key" ON "paye_bands"("scheduleId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employeeNumber_key" ON "employees"("employeeNumber");

-- CreateIndex
CREATE INDEX "employees_status_idx" ON "employees"("status");

-- CreateIndex
CREATE INDEX "employees_lastName_firstName_idx" ON "employees"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "employee_allowances_employeeId_idx" ON "employee_allowances"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_runNumber_key" ON "payroll_runs"("runNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_journalEntryId_key" ON "payroll_runs"("journalEntryId");

-- CreateIndex
CREATE INDEX "payroll_runs_status_idx" ON "payroll_runs"("status");

-- CreateIndex
CREATE INDEX "payroll_runs_periodYear_periodMonth_idx" ON "payroll_runs"("periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "payslips_employeeId_idx" ON "payslips"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_payrollRunId_employeeId_key" ON "payslips"("payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX "payslip_earnings_payslipId_idx" ON "payslip_earnings"("payslipId");

-- AddForeignKey
ALTER TABLE "paye_bands" ADD CONSTRAINT "paye_bands_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "statutory_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_allowances" ADD CONSTRAINT "employee_allowances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_statutoryScheduleId_fkey" FOREIGN KEY ("statutoryScheduleId") REFERENCES "statutory_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_earnings" ADD CONSTRAINT "payslip_earnings_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- NOTHING TO BACKFILL. Every table here is new and every column on it is new, so
-- there is no historical row whose meaning has to be defined. Payroll has simply
-- never been run on this system before, and an empty employee master is the truthful
-- statement about that.
-- ===========================================================================

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix). Cross-table trigger bodies qualify by TG_TABLE_SCHEMA, because the pg
-- adapter does not set search_path (the engineering ledger "Raw SQL and Tenant Schema
-- Resolution").
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) THE TWO NEW ACCOUNTS, seeded into EXISTING tenant schemas.
--
-- Provisioning seeds the whole chart from chart-of-accounts.ts for a NEW tenant, so
-- this block exists only for tenants that already traded before 8.1. Keyed on `code`
-- with ON CONFLICT DO NOTHING, so it is a zero-op on a schema that already has them
-- and running it after provisioning has seeded the chart cannot double-insert.
--
-- The enum casts are unqualified: this migration runs with the tenant schema on the
-- search_path, which is where AccountClass and NormalBalance live.
--
-- The chart becomes 48. The four statutory liability heads (2200 PAYE, 2210 NSSF,
-- 2220 SHA, 2230 Housing Levy) and 6020 Salaries & Wages were already there from
-- Phase 2.1 — which is the plug the engineering ledger claimed for Module 8 proving real, exactly
-- as the AP plug did for Module 7.
-- ---------------------------------------------------------------------------
INSERT INTO "accounts"
  ("id", "code", "name", "accountClass", "normalBalance", "description",
   "isSystem", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), '2120', 'Net Salaries Payable',
   'LIABILITY'::"AccountClass", 'CREDIT'::"NormalBalance",
   'Net pay owed to employees between the payroll ACCRUAL and the day it is actually paid. A payroll run credits it with the sum of every payslip''s net pay (Task 8.1); settling it debits it against cash (Task 8.2). It is the employee-facing counterpart of 2000 Accounts Payable, kept separate because what is owed to staff and what is owed to suppliers are answered by different reports and paid on different days.',
   true, true, now(), now())
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "accounts"
  ("id", "code", "name", "accountClass", "normalBalance", "description",
   "isSystem", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), '6025', 'Employer Statutory Contributions',
   'EXPENSE'::"AccountClass", 'DEBIT'::"NormalBalance",
   'The EMPLOYER''s own share of statutory contributions — matched NSSF and the employer half of the Affordable Housing Levy (Task 8.1). It is a cost of employment ON TOP of gross pay, which is why it is its own expense line and not folded into 6020: an employee''s gross is what they earned, while this is what employing them additionally cost. The employee''s own deductions are never an expense — they come OUT of the gross already in 6020.',
   true, true, now(), now())
ON CONFLICT ("code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- (b) PER-SCHEMA NUMBER SEQUENCES for employees and payroll runs.
--
-- Same mechanism as every other document number in this system (journal entries
-- 0003, PO/GRN 0017, supplier payments 0018, customer receipts 0020): monotonic and
-- unique, NOT gap-free, because a sequence is non-transactional and a rolled-back
-- insert burns its number. A missing internal employee or run number has no
-- regulatory meaning.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE employee_number_seq START 1;
CREATE SEQUENCE payroll_run_number_seq START 1;

-- ---------------------------------------------------------------------------
-- (c) EXACTLY ONE STATUTORY SCHEDULE MAY COVER ANY GIVEN DATE.
--
-- A GiST EXCLUSION CONSTRAINT over the half-open range
-- `[effectiveFrom, effectiveTo)`, with a NULL `effectiveTo` meaning unbounded. Two
-- schedules claiming the same month is therefore UNREPRESENTABLE, not merely
-- refused by a service.
--
-- WHY THIS AND NOT A TRIGGER: overlap is exactly what a range exclusion constraint
-- is for. It is declarative, it is checked on every writer including raw SQL, and it
-- costs one index. A trigger would have to hand-roll the interval algebra and get
-- the NULL-upper-bound case right, which is the case that matters most — the
-- currently in-force schedule is precisely the one with an open end.
--
-- WHY IT MATTERS: if two schedules could cover February, a payroll run would have to
-- pick one, and picking wrong means every employee's PAYE is computed on the wrong
-- bands. The service refuses to guess when the resolution is not unique; this makes
-- the ambiguity impossible in the first place.
-- ---------------------------------------------------------------------------
ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_no_overlap
  EXCLUDE USING gist (daterange("effectiveFrom", "effectiveTo", '[)') WITH &&);

-- An open range would mean "governs nothing", which is never what was intended.
ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_window_ordered
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- RATES ARE PERCENTAGES, NOT MONEY. 0-100 inclusive: a zero rate is a real
-- treatment (a suspended levy) and must stay expressible.
ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_rates_are_percentages
  CHECK ("nssfRatePercent" >= 0 AND "nssfRatePercent" <= 100
     AND "shifRatePercent" >= 0 AND "shifRatePercent" <= 100
     AND "ahlRatePercent"  >= 0 AND "ahlRatePercent"  <= 100);

-- Money figures on a schedule are non-negative, and the NSSF tier boundary must sit
-- below the ceiling it divides.
ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_amounts_coherent
  CHECK ("personalRelief" >= 0 AND "shifMinimum" >= 0
     AND "nssfLowerLimit" >= 0 AND "nssfUpperLimit" > "nssfLowerLimit");

-- The provenance fields are the whole point of the engineering ledger's verify-and-record rule;
-- a blank citation would defeat it.
ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_source_recorded
  CHECK (btrim("source") <> '');

-- ---------------------------------------------------------------------------
-- (d) A SCHEDULE IS IMMUTABLE ONCE A PAYROLL RUN HAS USED IT.
--
-- Not blanket-immutable: a typo in a schedule nobody has computed against is worth
-- correcting in place. But the moment a run has recorded `statutoryScheduleId`, that
-- schedule is the evidence for every payslip in it — editing a rate afterwards would
-- make the stored payslips unreproducible and silently restate what the business
-- told KRA it owed.
--
-- The window may never move once used, either: that is what decides WHICH period the
-- ruleset governs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION statutory_schedule_guard() RETURNS trigger AS $$
DECLARE
  v_runs integer;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I.payroll_runs WHERE "statutoryScheduleId" = $1',
                 TG_TABLE_SCHEMA)
    INTO v_runs USING OLD."id";

  IF v_runs > 0 THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'Statutory schedule % cannot be deleted: % payroll run(s) were computed against it, and their payslips would become unreproducible.',
        OLD."label", v_runs;
    END IF;
    IF NEW."effectiveFrom"   IS DISTINCT FROM OLD."effectiveFrom"
       OR NEW."effectiveTo"     IS DISTINCT FROM OLD."effectiveTo"
       OR NEW."personalRelief"  IS DISTINCT FROM OLD."personalRelief"
       OR NEW."nssfRatePercent" IS DISTINCT FROM OLD."nssfRatePercent"
       OR NEW."nssfLowerLimit"  IS DISTINCT FROM OLD."nssfLowerLimit"
       OR NEW."nssfUpperLimit"  IS DISTINCT FROM OLD."nssfUpperLimit"
       OR NEW."shifRatePercent" IS DISTINCT FROM OLD."shifRatePercent"
       OR NEW."shifMinimum"     IS DISTINCT FROM OLD."shifMinimum"
       OR NEW."ahlRatePercent"  IS DISTINCT FROM OLD."ahlRatePercent"
    THEN
      RAISE EXCEPTION
        'Statutory schedule % is frozen: % payroll run(s) were computed against it. A rate change is a NEW dated schedule, never an edit to one already used — otherwise a posted payslip stops agreeing with the rules it was computed under.',
        OLD."label", v_runs;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER statutory_schedule_guard_ud
  BEFORE UPDATE OR DELETE ON statutory_schedules
  FOR EACH ROW EXECUTE FUNCTION statutory_schedule_guard();

-- ---------------------------------------------------------------------------
-- (e) PAYE BAND FIELD CONSTRAINTS.
-- ---------------------------------------------------------------------------
ALTER TABLE "paye_bands" ADD CONSTRAINT paye_band_ordinal_positive
  CHECK ("ordinal" >= 1);

ALTER TABLE "paye_bands" ADD CONSTRAINT paye_band_bounds_ascending
  CHECK ("lowerBound" >= 0 AND ("upperBound" IS NULL OR "upperBound" > "lowerBound"));

ALTER TABLE "paye_bands" ADD CONSTRAINT paye_band_rate_is_a_percentage
  CHECK ("ratePercent" >= 0 AND "ratePercent" <= 100);

-- ---------------------------------------------------------------------------
-- (f) DEFERRED CONSTRAINT: THE BANDS OF A SCHEDULE ARE A COMPLETE, CONTIGUOUS,
-- ASCENDING PARTITION OF TAXABLE PAY FROM ZERO UPWARDS.
--
-- Specifically, at COMMIT, for every schedule that has any bands:
--   * ordinals run 1..n with no gaps (the unique index already stops duplicates);
--   * band 1 starts at EXACTLY 0 — every shilling of taxable pay must fall in a band;
--   * band n's `lowerBound` == band n-1's `upperBound` — no gap, no overlap;
--   * exactly ONE band is open-topped, and it is the LAST one.
--
-- WHY DEFERRED AND NOT A ROW CHECK: contiguity is a property of the SET. A row CHECK
-- cannot see the neighbouring band, and an immediate trigger would refuse the first
-- INSERT of a perfectly good ladder because the rest of it has not arrived yet.
-- DEFERRABLE INITIALLY DEFERRED is the same mechanism `journal_balance_check` uses
-- for debits = credits (0003, made schema-safe in 0004) and for the same reason.
--
-- WHY IT MATTERS MORE THAN MOST: a GAP between bands silently taxes nothing in it,
-- and an OVERLAP taxes the same shillings twice. Either one is wrong for every
-- employee whose pay lands there, it is invisible in the totals, and it would be
-- discovered by KRA rather than by us.
--
-- Bound to `paye_bands` only. A schedule row cannot falsify band contiguity — the
-- bands are what the rule is about — so the both-sides rule that applies to the
-- payables and receivables aggregates has nothing to bind to here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_paye_bands_contiguous() RETURNS trigger AS $$
DECLARE
  v_schema     text := TG_TABLE_SCHEMA;
  v_schedule   text;
  v_label      text;
  v_count      integer;
  v_open_tops  integer;
  v_first_low  bigint;
  v_last_ord   integer;
  v_bad        record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_schedule := OLD."scheduleId";
  ELSE
    v_schedule := NEW."scheduleId";
  END IF;

  EXECUTE format('SELECT "label" FROM %I.statutory_schedules WHERE "id" = $1', v_schema)
    INTO v_label USING v_schedule;
  -- Parent schedule gone (a cascade): there is nothing left to validate.
  IF v_label IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format(
    'SELECT count(*), count(*) FILTER (WHERE "upperBound" IS NULL),
            min("lowerBound"), max("ordinal")
       FROM %I.paye_bands WHERE "scheduleId" = $1', v_schema)
    INTO v_count, v_open_tops, v_first_low, v_last_ord USING v_schedule;

  -- A schedule with no bands at all is caught when a run tries to use it, not here:
  -- the bands are inserted after the schedule, so an empty set is a legitimate
  -- intermediate state within the seeding transaction.
  IF v_count = 0 THEN
    RETURN NULL;
  END IF;

  IF v_last_ord <> v_count THEN
    RAISE EXCEPTION
      'PAYE bands for schedule % are not numbered 1..% (highest ordinal is %). Every band must sit in the ladder.',
      v_label, v_count, v_last_ord;
  END IF;

  IF v_first_low <> 0 THEN
    RAISE EXCEPTION
      'PAYE bands for schedule % must start at 0 (lowest band starts at % cents). Every shilling of taxable pay has to fall in a band.',
      v_label, v_first_low;
  END IF;

  IF v_open_tops <> 1 THEN
    RAISE EXCEPTION
      'PAYE bands for schedule % have % open-topped bands; there must be EXACTLY one, and it must be the highest.',
      v_label, v_open_tops;
  END IF;

  -- The open-topped band must be the last one, or pay above it would fall into a
  -- lower band's range as well.
  EXECUTE format(
    'SELECT "ordinal" FROM %I.paye_bands WHERE "scheduleId" = $1 AND "upperBound" IS NULL',
    v_schema)
    INTO v_last_ord USING v_schedule;
  IF v_last_ord <> v_count THEN
    RAISE EXCEPTION
      'PAYE bands for schedule %: the open-topped band is ordinal % but must be the highest (%).',
      v_label, v_last_ord, v_count;
  END IF;

  -- CONTIGUITY: each band must begin exactly where the previous one ended.
  EXECUTE format(
    'SELECT b."ordinal" ord, b."lowerBound" low, p."upperBound" prev_high
       FROM %I.paye_bands b
       JOIN %I.paye_bands p ON p."scheduleId" = b."scheduleId" AND p."ordinal" = b."ordinal" - 1
      WHERE b."scheduleId" = $1
        AND (p."upperBound" IS NULL OR p."upperBound" <> b."lowerBound")
      LIMIT 1', v_schema, v_schema)
    INTO v_bad USING v_schedule;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'PAYE bands for schedule % are not contiguous: band % starts at % but the band below it ends at %. A gap would tax nothing in it; an overlap would tax the same shillings twice.',
      v_label, v_bad.ord, v_bad.low, COALESCE(v_bad.prev_high::text, 'unbounded');
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER paye_bands_contiguous_check
  AFTER INSERT OR UPDATE OR DELETE ON paye_bands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_paye_bands_contiguous();

-- ---------------------------------------------------------------------------
-- (g) EMPLOYEE AND ALLOWANCE FIELD CONSTRAINTS.
-- ---------------------------------------------------------------------------
ALTER TABLE "employees" ADD CONSTRAINT employee_number_positive
  CHECK ("employeeNumber" > 0);

ALTER TABLE "employees" ADD CONSTRAINT employee_names_not_blank
  CHECK (btrim("firstName") <> '' AND btrim("lastName") <> '');

-- A salary of zero is legal (an unpaid director, a volunteer on the books); negative
-- is not, and would make every figure derived from it nonsense.
ALTER TABLE "employees" ADD CONSTRAINT employee_basic_salary_non_negative
  CHECK ("basicSalary" >= 0);

-- A termination date before the hire date is a typo, not a record. The date is
-- REQUIRED once terminated and must be absent otherwise, so a half-written
-- termination cannot exist as a row.
ALTER TABLE "employees" ADD CONSTRAINT employee_termination_coherent
  CHECK (
    CASE
      WHEN "status" = 'TERMINATED'
        THEN "terminationDate" IS NOT NULL AND "terminationDate" >= "hireDate"
      ELSE "terminationDate" IS NULL
    END
  );

ALTER TABLE "employee_allowances" ADD CONSTRAINT employee_allowance_amount_non_negative
  CHECK ("amount" >= 0);

ALTER TABLE "employee_allowances" ADD CONSTRAINT employee_allowance_name_not_blank
  CHECK (btrim("name") <> '');

-- ---------------------------------------------------------------------------
-- (h) PAYROLL RUN FIELD CONSTRAINTS, AND ONE PAYROLL PER MONTH.
-- ---------------------------------------------------------------------------
ALTER TABLE "payroll_runs" ADD CONSTRAINT payroll_run_number_positive
  CHECK ("runNumber" > 0);

ALTER TABLE "payroll_runs" ADD CONSTRAINT payroll_run_period_valid
  CHECK ("periodMonth" BETWEEN 1 AND 12 AND "periodYear" BETWEEN 2000 AND 2200);

-- WHICH COLUMNS EACH STATUS MUST AND MUST NOT CARRY. A half-written run — POSTED
-- with no entry, APPROVED with no approver, a DRAFT already claiming a journal
-- entry — cannot exist as a row even if inserted directly. The state machine below
-- governs the TRANSITIONS; this governs the RESTING STATE, and both are needed
-- because a trigger cannot see a row inserted straight into its final shape.
ALTER TABLE "payroll_runs" ADD CONSTRAINT payroll_run_status_fields_coherent
  CHECK (
    CASE "status"
      WHEN 'DRAFT'     THEN "approvedById" IS NULL AND "postedAt" IS NULL AND "journalEntryId" IS NULL
      WHEN 'APPROVED'  THEN "approvedById" IS NOT NULL AND "postedAt" IS NULL AND "journalEntryId" IS NULL
      WHEN 'POSTED'    THEN "approvedById" IS NOT NULL AND "postedAt" IS NOT NULL AND "journalEntryId" IS NOT NULL
      WHEN 'CANCELLED' THEN "postedAt" IS NULL AND "journalEntryId" IS NULL
    END
  );

-- ONE PAYROLL PER CALENDAR MONTH. Partial, so a CANCELLED run does not block the
-- corrected one that replaces it — the same partial-unique pattern as the single
-- MAIN location (0013) and the offline idempotency key (0015).
--
-- Two live payrolls for one month would double the accrual: twice the salary
-- expense, twice what every statutory head is owed, and two net-pay obligations for
-- the same work.
CREATE UNIQUE INDEX payroll_run_one_live_per_period
  ON "payroll_runs" ("periodYear", "periodMonth")
  WHERE "status" <> 'CANCELLED';

-- ---------------------------------------------------------------------------
-- (i) THE PAYROLL RUN STATE MACHINE AND ITS IMMUTABILITY.
--
-- DRAFT     -> APPROVED | CANCELLED
-- APPROVED  -> POSTED | CANCELLED
-- POSTED    -> terminal (settlement is Task 8.2)
-- CANCELLED -> terminal
--
-- **A DRAFT HAS POSTED NOTHING**, which is what makes it freely recomputable: the
-- payroll officer can re-snapshot it as often as they like while they chase a
-- missing allowance, and the ledger never hears about it. Posting books the accrual
-- and freezes the figures in the same transaction, so there is no window in which the
-- books and the payslips disagree.
--
-- A run is BORN a DRAFT (trigger): inserting one already POSTED would skip the
-- posting transaction entirely and leave the liabilities with no entry behind them.
--
-- **CANCELLED IS ONLY REACHABLE BEFORE POSTING.** Once the accrual is booked, "this
-- payroll never happened" is false — the correction is a reversing entry, which
-- belongs with settlement in 8.2. That is also why POSTED is terminal here: there is
-- nothing a posted accrual can become until something can pay it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payroll_run_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION
        'Payroll run for %-% must be created as a DRAFT (got %). Posting is a separate operation because it is what books the accrual.',
        NEW."periodYear", NEW."periodMonth", NEW."status";
    END IF;
    RETURN NEW;
  END IF;

  -- Identity and period are frozen forever: a run IS a month's payroll, and
  -- re-pointing it at another month would move an accrual between periods.
  IF NEW."id"            IS DISTINCT FROM OLD."id"
     OR NEW."runNumber"   IS DISTINCT FROM OLD."runNumber"
     OR NEW."periodYear"  IS DISTINCT FROM OLD."periodYear"
     OR NEW."periodMonth" IS DISTINCT FROM OLD."periodMonth"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt"   IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'Payroll run % : its identity (number, period, who created it, when) can never be changed.',
      OLD."runNumber";
  END IF;

  -- The ruleset and the pay date freeze the moment the run leaves DRAFT, because
  -- from then on the payslips were computed from them.
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."statutoryScheduleId" IS DISTINCT FROM OLD."statutoryScheduleId"
       OR NEW."payDate" IS DISTINCT FROM OLD."payDate"
    THEN
      RAISE EXCEPTION
        'Payroll run % is % : the statutory schedule it used and its pay date are frozen. Its payslips were computed from them.',
        OLD."runNumber", OLD."status";
    END IF;
  END IF;

  -- The journal entry is write-once.
  IF OLD."journalEntryId" IS NOT NULL
     AND NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" THEN
    RAISE EXCEPTION
      'Payroll run % already has accrual entry %; a posted entry is immutable and is corrected by a reversal, never by re-pointing the run.',
      OLD."runNumber", OLD."journalEntryId";
  END IF;

  -- THE STATE MACHINE.
  IF NEW."status" <> OLD."status" THEN
    IF OLD."status" = 'DRAFT' THEN
      IF NEW."status" NOT IN ('APPROVED', 'CANCELLED') THEN
        RAISE EXCEPTION
          'Payroll run % : a DRAFT may only be APPROVED or CANCELLED (got %). It cannot be posted without being approved first.',
          OLD."runNumber", NEW."status";
      END IF;
    ELSIF OLD."status" = 'APPROVED' THEN
      IF NEW."status" NOT IN ('POSTED', 'CANCELLED') THEN
        RAISE EXCEPTION
          'Payroll run % : an APPROVED run may only be POSTED or CANCELLED (got %).',
          OLD."runNumber", NEW."status";
      END IF;
      IF NEW."status" = 'POSTED' AND NEW."journalEntryId" IS NULL THEN
        RAISE EXCEPTION
          'Payroll run % cannot be POSTED without its accrual journal entry.',
          OLD."runNumber";
      END IF;
    ELSE
      RAISE EXCEPTION
        'Payroll run % is % , which is terminal. No further transition is possible (attempted %). A posted accrual is corrected by a reversing entry, not by re-opening the run.',
        OLD."runNumber", OLD."status", NEW."status";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_run_guard_iu
  BEFORE INSERT OR UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION payroll_run_guard();

-- A run that has been posted cannot be deleted: its accrual entry would be orphaned
-- and seven account balances would be left with nothing explaining them. A DRAFT or
-- a CANCELLED run has posted nothing and may be discarded.
CREATE OR REPLACE FUNCTION payroll_run_no_delete_once_posted() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'POSTED' THEN
    RAISE EXCEPTION
      'Payroll run % is POSTED and cannot be deleted: its accrual entry would be orphaned and the salary expense, the four statutory liabilities and net salaries payable would all be left unexplained.',
      OLD."runNumber";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_run_no_delete_posted
  BEFORE DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION payroll_run_no_delete_once_posted();

-- ---------------------------------------------------------------------------
-- (j) PAYSLIP FIELD CONSTRAINTS — the arithmetic of the computation, pinned.
--
-- EVERY component is non-negative: no part of a payslip can be negative, which is
-- the structural form of "a deduction can never exceed what it is deducted from".
--
-- The three identities below are what make a payslip internally checkable without
-- re-running the engine. They are per-row and therefore cheap, which is exactly the
-- kind of rule the engineering ledger says belongs in the database.
-- ---------------------------------------------------------------------------
ALTER TABLE "payslips" ADD CONSTRAINT payslip_amounts_non_negative
  CHECK ("grossPay" >= 0 AND "taxableGross" >= 0
     AND "nssfEmployee" >= 0 AND "nssfEmployer" >= 0
     AND "nssfTier1" >= 0 AND "nssfTier2" >= 0
     AND "shifEmployee" >= 0 AND "ahlEmployee" >= 0 AND "ahlEmployer" >= 0
     AND "taxablePay" >= 0 AND "payeBeforeRelief" >= 0
     AND "personalReliefApplied" >= 0 AND "paye" >= 0
     AND "totalEmployeeDeductions" >= 0 AND "netPay" >= 0);

-- The taxable part of pay can never exceed the whole of it.
ALTER TABLE "payslips" ADD CONSTRAINT payslip_taxable_gross_within_gross
  CHECK ("taxableGross" <= "grossPay");

-- The NSSF tier split must total the employee's contribution exactly. Both tiers
-- carry the same rate today, so this is the rule that keeps the split honest if a
-- future schedule prices them differently.
ALTER TABLE "payslips" ADD CONSTRAINT payslip_nssf_tiers_total
  CHECK ("nssfTier1" + "nssfTier2" = "nssfEmployee");

-- PAYE is the banded tax less the relief actually used, and the relief can never
-- exceed the tax — a relief does not become a refund.
ALTER TABLE "payslips" ADD CONSTRAINT payslip_paye_after_relief
  CHECK ("personalReliefApplied" <= "payeBeforeRelief"
     AND "paye" = "payeBeforeRelief" - "personalReliefApplied");

-- The deduction total is exactly its four parts.
ALTER TABLE "payslips" ADD CONSTRAINT payslip_deductions_total
  CHECK ("totalEmployeeDeductions" = "nssfEmployee" + "shifEmployee" + "ahlEmployee" + "paye");

-- AND NET IS GROSS LESS DEDUCTIONS. With the identity above, this is what makes
-- `Σ gross = Σ deductions + Σ net` hold across a whole run — which is the arithmetic
-- the accrual entry depends on to balance.
ALTER TABLE "payslips" ADD CONSTRAINT payslip_net_is_gross_less_deductions
  CHECK ("netPay" = "grossPay" - "totalEmployeeDeductions");

ALTER TABLE "payslip_earnings" ADD CONSTRAINT payslip_earning_amount_non_negative
  CHECK ("amount" >= 0);

ALTER TABLE "payslip_earnings" ADD CONSTRAINT payslip_earning_name_not_blank
  CHECK (btrim("name") <> '');

-- ---------------------------------------------------------------------------
-- (k) A PAYSLIP IS FROZEN THE MOMENT ITS RUN LEAVES DRAFT.
--
-- Template: `purchase_order_line_guard` (0017) and `supplier_bill_line_guard` (0018).
-- The payslips ARE the accrual entry: adding one to a posted run would credit net pay
-- nothing debits, and editing one would make the seven posted legs disagree with the
-- columns they were summed from.
--
-- While the run is a DRAFT, payslips are freely replaced — that is what `recompute`
-- does, and why it is safe.
--
-- The same guard covers `payslip_earnings` through its parent payslip, so the
-- snapshot of what an employee earned cannot be edited after the fact either.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payslip_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_run    integer;
  v_id     text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_id := OLD."payrollRunId";
  ELSE
    v_id := NEW."payrollRunId";
  END IF;

  EXECUTE format('SELECT "status"::text, "runNumber" FROM %I.payroll_runs WHERE "id" = $1',
                 TG_TABLE_SCHEMA)
    INTO v_status, v_run USING v_id;

  -- A cascade from deleting the run itself leaves no parent row to check, and a
  -- DRAFT or CANCELLED run is discardable with its payslips.
  IF v_status IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Payslip references payroll run %, which does not exist.', v_id;
  END IF;

  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'Payroll run % is % : its payslips are frozen, because they ARE its accrual entry. Only a DRAFT run may have its payslips recomputed.',
      v_run, v_status;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payslip_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON payslips
  FOR EACH ROW EXECUTE FUNCTION payslip_guard();

CREATE OR REPLACE FUNCTION payslip_earning_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_run    integer;
  v_id     text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_id := OLD."payslipId";
  ELSE
    v_id := NEW."payslipId";
  END IF;

  EXECUTE format(
    'SELECT r."status"::text, r."runNumber"
       FROM %I.payslips p JOIN %I.payroll_runs r ON r."id" = p."payrollRunId"
      WHERE p."id" = $1', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
    INTO v_status, v_run USING v_id;

  IF v_status IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Payslip earning references payslip %, which does not exist.', v_id;
  END IF;

  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'Payroll run % is % : the earnings snapshot on its payslips is frozen. It is the record of what each employee was paid under, and a later salary revision must never restate it.',
      v_run, v_status;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payslip_earning_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON payslip_earnings
  FOR EACH ROW EXECUTE FUNCTION payslip_earning_guard();

-- ---------------------------------------------------------------------------
-- (l) SEED THE VERIFIED STATUTORY SCHEDULE for every EXISTING tenant.
--
-- For a NEW tenant this is done by provisioning (`seedStatutorySchedule` in
-- src/services/tenant-provisioning.ts, called beside `seedChartOfAccounts`), so this
-- block exists only for tenants that already existed before 8.1. Keyed on `label`
-- with ON CONFLICT DO NOTHING, so it is a zero-op on a schema that already has it and
-- cannot double-insert when provisioning has already seeded.
--
-- **THE SAME PLATFORM-RUN MECHANISM AS THE CHART, AND THAT IS THE POINT.** A
-- statutory update is then ONE dated operation applied across every tenant — a new
-- migration or a run of the seeder — never a per-tenant edit that would leave two
-- MSMEs computing PAYE differently in the same month.
--
-- FIGURES VERIFIED 2026-10-04 against the sources recorded in the `source` column.
-- See the engineering ledger "Payroll" for the full citation list and the standing rule that they
-- must be re-verified (not copied forward) whenever this is next touched.
--
--   Personal relief      KES 2,400.00 / month
--   NSSF                 6% employee + 6% matched employer, LEL 9,000, UEL 108,000
--                        (NSSF Act 2013 Year Four, effective February 2026)
--   SHIF                 2.75% of gross, minimum KES 300, no upper cap
--   Housing Levy         1.5% employee + 1.5% matched employer
--   PAYE bands           10% / 25% / 30% / 32.5% / 35%
--
-- The window opens 2026-02-01 because that is when NSSF Year Four limits took
-- effect; the PAYE bands, relief, SHIF and AHL figures were already in force before
-- then, so February is the date the COMBINED ruleset changed.
-- ---------------------------------------------------------------------------
INSERT INTO "statutory_schedules"
  ("id", "label", "effectiveFrom", "effectiveTo", "source", "verifiedOn", "notes",
   "personalRelief", "nssfRatePercent", "nssfLowerLimit", "nssfUpperLimit",
   "shifRatePercent", "shifMinimum", "ahlRatePercent", "createdAt")
VALUES
  ('00000000-0000-4000-8000-000000210001', 'KE-2026-02', DATE '2026-02-01', NULL,
   'NSSF Act 2013 Year Four limits (LEL 9,000 / UEL 108,000, 6% matched) effective Feb 2026; Social Health Insurance Fund 2.75% of gross with a KES 300 monthly minimum and no cap (SHA, replacing NHIF from Oct 2024); Affordable Housing Levy 1.5% employee + 1.5% employer; PAYE bands and KES 2,400/month personal relief per the Income Tax Act as amended by the Finance Act 2023; NSSF, SHIF and AHL treated as ALLOWABLE DEDUCTIONS against taxable pay per the Tax Laws (Amendment) Act 2024, effective 27 December 2024. Verified 2026-10-04.',
   DATE '2026-10-04',
   'Monthly salaried employees only. The Tax Laws (Amendment) Act 2024 changed NSSF, SHIF and AHL from reliefs against tax to allowable deductions against taxable pay — the engine applies them before the bands, which is what makes the deduction order load-bearing rather than cosmetic.',
   240000, 6.00, 900000, 10800000, 2.75, 30000, 1.50, now())
ON CONFLICT ("label") DO NOTHING;

INSERT INTO "paye_bands" ("id", "scheduleId", "ordinal", "lowerBound", "upperBound", "ratePercent")
SELECT v.id, '00000000-0000-4000-8000-000000210001', v.ordinal, v.lower_bound, v.upper_bound, v.rate
FROM (VALUES
  ('00000000-0000-4000-8000-000000210101'::text, 1, 0::bigint,        2400000::bigint, 10.00),
  ('00000000-0000-4000-8000-000000210102',       2, 2400000::bigint,  3233300::bigint, 25.00),
  ('00000000-0000-4000-8000-000000210103',       3, 3233300::bigint, 50000000::bigint, 30.00),
  ('00000000-0000-4000-8000-000000210104',       4, 50000000::bigint, 80000000::bigint, 32.50),
  ('00000000-0000-4000-8000-000000210105',       5, 80000000::bigint, NULL::bigint,     35.00)
) AS v(id, ordinal, lower_bound, upper_bound, rate)
WHERE EXISTS (SELECT 1 FROM "statutory_schedules" WHERE "id" = '00000000-0000-4000-8000-000000210001')
ON CONFLICT ("scheduleId", "ordinal") DO NOTHING;

-- ---------------------------------------------------------------------------
-- (m) DELIBERATELY NO CONSTRAINT tying a payroll run's accrual entry to the SUM of
-- its payslip columns.
--
-- It is a cross-row aggregate over a whole run's payslips, and it would have to
-- re-aggregate every payslip on each write. Same considered trade-off as the stock
-- aggregate in 0011, `PurchaseOrder.subtotal` in 0017, `billedQty` in 0018 and
-- `creditBalance` in 0020: the database enforces what is cheap and local — and here
-- that is a lot, because every per-payslip identity in (j) is pinned — one service
-- writes both sides inside ONE transaction, the posting code ASSERTS the entry
-- balances before it is written and fails loudly otherwise, and the run-level
-- agreement is an acceptance criterion.
--
-- What makes this safe rather than merely cheap: `payslip_net_is_gross_less_deductions`
-- and `payslip_deductions_total` together guarantee
-- `Σ gross = Σ nssfEmployee + Σ shif + Σ ahlEmployee + Σ paye + Σ net` for ANY set of
-- payslips. The accrual entry's seven legs are exactly those sums plus the two
-- employer contributions on both sides, so the entry balances BY CONSTRUCTION from
-- rules the database already enforces per row. Recorded here so the absence is read
-- as a decision.
-- ---------------------------------------------------------------------------
