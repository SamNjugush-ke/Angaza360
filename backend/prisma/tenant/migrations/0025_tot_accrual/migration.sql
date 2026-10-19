-- ===========================================================================
-- 0025 — TURNOVER TAX ACCRUAL (Task 3B.2). HAND-WRITTEN.
--
-- A TURNOVER_TAX tenant pays a final tax on gross turnover INSTEAD of VAT. After 3B.1
-- such a tenant correctly charges no VAT; this migration lays the ground for accruing
-- the TOT it owes, per sale, inside the sale's own revenue entry:
--
--     Dr 6110 Turnover Tax       rate x turnover, rounded once
--     Cr 2110 TOT Payable        the same
--
-- FORWARD-ONLY. `Sale.totAccrued` defaults to 0 on every existing sale, which is the
-- truth: no pre-3B.2 sale accrued TOT. Back-accruing historical TOT is a business
-- decision, not a migration. No sale, journal entry or balance is touched here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) THE CHART: 6110 Turnover Tax (the expense). 2110 TOT Payable already exists.
-- Keyed on code, ON CONFLICT DO NOTHING — a zero-op where provisioning seeded it.
-- The chart becomes 49.
-- ---------------------------------------------------------------------------
INSERT INTO "accounts"
  ("id", "code", "name", "accountClass", "normalBalance", "description",
   "isSystem", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), '6110', 'Turnover Tax',
   'EXPENSE'::"AccountClass", 'DEBIT'::"NormalBalance",
   'Turnover Tax accrued on gross sales by a TURNOVER_TAX tenant (Task 3B.2): rate x turnover per sale, credited to 2110 TOT Payable in the same entry. A final tax on the BUSINESS, not charged to the customer — which is why it is an expense rather than a deduction from revenue, and why it never appears on a receipt.',
   true, true, now(), now())
ON CONFLICT ("code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- (b) THE TOT RATE on the statutory schedule, with its own provenance.
--
-- RECORDED 2026-10-11: 3.00% of gross turnover — Income Tax Act (Cap. 470) s.12C and
-- the Third Schedule as amended by the Finance Act 2023 (from 1% to 3%, effective
-- 1 July 2023); corroborated by PwC Tax Summaries (Kenya, 2026). No later amending Act
-- was found (the Tax Laws (Amendment) Act 2024, the Tax Procedures (Amendment) Act 2024
-- and the Finance Act 2025 do not amend TOT). OPEN DISCREPANCY, recorded rather than
-- resolved by assumption: KRA's own TOT web page states 1.5% "as per Finance Act 2023",
-- contradicting the Act it cites; the gazetted text was not reachable at verification.
-- 3% was chosen by the product owner after review.
-- ---------------------------------------------------------------------------
ALTER TABLE "statutory_schedules"
  ADD COLUMN "totRatePercent"    DECIMAL(5,2) NOT NULL DEFAULT 3.00,
  ADD COLUMN "totRateSource"     TEXT NOT NULL DEFAULT 'Income Tax Act (Cap. 470) s.12C and Third Schedule as amended by the Finance Act 2023: Turnover Tax 3% of gross turnover (raised from 1%), effective 1 July 2023, for resident persons with business turnover above KES 1,000,000 and not above KES 25,000,000. Corroborated by PwC Tax Summaries (Kenya, 2026); no later amending Act found (Tax Laws (Amendment) Act 2024, Tax Procedures (Amendment) Act 2024 and Finance Act 2025 do not amend TOT). OPEN DISCREPANCY: KRA''s TOT web page states 1.5% "as per Finance Act 2023", contradicting that Act; gazetted text not reachable at verification. Verified 2026-10-11.',
  ADD COLUMN "totRateVerifiedOn" DATE NOT NULL DEFAULT DATE '2026-10-11';

ALTER TABLE "statutory_schedules"
  ALTER COLUMN "totRatePercent" DROP DEFAULT,
  ALTER COLUMN "totRateSource" DROP DEFAULT,
  ALTER COLUMN "totRateVerifiedOn" DROP DEFAULT;

ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_tot_rate_is_a_percentage
  CHECK ("totRatePercent" > 0 AND "totRatePercent" <= 100);

ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_tot_source_recorded
  CHECK (btrim("totRateSource") <> '');

-- ---------------------------------------------------------------------------
-- (c) SALE.totAccrued — the snapshot a void reverses.
--
-- Non-negative, and a sale NEVER carries both TOT and VAT: TOT is the tax a business
-- pays instead of VAT, so a sale with both would be one tenant on two regimes at once.
-- ---------------------------------------------------------------------------
ALTER TABLE "sales" ADD COLUMN "totAccrued" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "sales" ADD CONSTRAINT sale_tot_accrued_non_negative
  CHECK ("totAccrued" >= 0);

ALTER TABLE "sales" ADD CONSTRAINT sale_tot_and_vat_exclusive
  CHECK ("totAccrued" = 0 OR "vatTotal" = 0);

-- ---------------------------------------------------------------------------
-- (d) THE SCHEDULE GUARD, extended to the TOT rate. Same rule as the VAT rate (0024):
-- once a sale falls inside a schedule's window, its TOT rate is frozen — editing it
-- would make posted accruals disagree with the rate that governed them. A rate change
-- is a NEW dated schedule. Body is 0024's with the one column added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION statutory_schedule_guard() RETURNS trigger AS $$
DECLARE
  v_runs  integer;
  v_sales integer;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I.payroll_runs WHERE "statutoryScheduleId" = $1',
                 TG_TABLE_SCHEMA)
    INTO v_runs USING OLD."id";

  EXECUTE format(
    'SELECT count(*) FROM %I.journal_entries
      WHERE "source" = ''POS''
        AND "entryDate" >= $1
        AND ($2::date IS NULL OR "entryDate" < $2::date)',
    TG_TABLE_SCHEMA)
    INTO v_sales USING OLD."effectiveFrom", OLD."effectiveTo";

  IF v_runs > 0 OR v_sales > 0 THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'Statutory schedule % cannot be deleted: % payroll run(s) and % sale entr(ies) were computed under it, and they would become unreproducible.',
        OLD."label", v_runs, v_sales;
    END IF;
    IF NEW."effectiveFrom"      IS DISTINCT FROM OLD."effectiveFrom"
       OR NEW."effectiveTo"     IS DISTINCT FROM OLD."effectiveTo"
       OR NEW."vatStandardRate" IS DISTINCT FROM OLD."vatStandardRate"
       OR NEW."totRatePercent"  IS DISTINCT FROM OLD."totRatePercent"
    THEN
      RAISE EXCEPTION
        'Statutory schedule % is frozen: % payroll run(s) and % sale entr(ies) fall under it. Its window, VAT rate and TOT rate cannot change; a rate change is a NEW dated schedule.',
        OLD."label", v_runs, v_sales;
    END IF;
  END IF;

  IF v_runs > 0 THEN
    IF NEW."personalRelief"     IS DISTINCT FROM OLD."personalRelief"
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

-- ---------------------------------------------------------------------------
-- (e) THE SALE GUARD, extended to freeze `totAccrued`. It is set at INSERT (the guard
-- is BEFORE UPDATE, so insert is unrestricted) and may never change afterwards:
-- rewriting it would make a later void reverse a different amount than was accrued.
-- Body is 0020's with the one column added to the immutable set.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sale_guard_update() RETURNS trigger AS $$
BEGIN
  -- Financial / identity fields are immutable, always.
  IF NEW.id                 IS DISTINCT FROM OLD.id
     OR NEW."saleNumber"    IS DISTINCT FROM OLD."saleNumber"
     OR NEW."shiftId"       IS DISTINCT FROM OLD."shiftId"
     OR NEW."customerId"    IS DISTINCT FROM OLD."customerId"
     OR NEW.subtotal        IS DISTINCT FROM OLD.subtotal
     OR NEW."vatTotal"      IS DISTINCT FROM OLD."vatTotal"
     OR NEW.total           IS DISTINCT FROM OLD.total
     OR NEW."cogsTotal"     IS DISTINCT FROM OLD."cogsTotal"
     OR NEW."saleJournalEntryId" IS DISTINCT FROM OLD."saleJournalEntryId"
     OR NEW.reference       IS DISTINCT FROM OLD.reference
     OR NEW."createdBy"     IS DISTINCT FROM OLD."createdBy"
     OR NEW."createdAt"     IS DISTINCT FROM OLD."createdAt"
     -- Task 3.2-LOC: where the stock came from is part of the sale's identity.
     OR NEW."sellingLocationId" IS DISTINCT FROM OLD."sellingLocationId"
     -- Task OFF.1: so is where the sale came from, when it happened, which
     -- device captured it, and which key was consumed for it.
     OR NEW."origin"               IS DISTINCT FROM OLD."origin"
     OR NEW."businessTimestamp"    IS DISTINCT FROM OLD."businessTimestamp"
     OR NEW."syncedAt"             IS DISTINCT FROM OLD."syncedAt"
     OR NEW."deviceId"             IS DISTINCT FROM OLD."deviceId"
     OR NEW."idempotencyKey"       IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."originalBusinessDate" IS DISTINCT FROM OLD."originalBusinessDate"
     -- Task 3B.2: the TOT accrued is exactly what a void reverses.
     OR NEW."totAccrued"           IS DISTINCT FROM OLD."totAccrued"
  THEN
    RAISE EXCEPTION 'Sale % is immutable; only voiding, payment settlement, fiscal status and received receivable may change.',
      OLD."saleNumber";
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- A status change is permitted ONLY as the void transition.
    IF NOT (OLD.status::text = 'COMPLETED' AND NEW.status::text = 'VOIDED') THEN
      RAISE EXCEPTION 'Sale % status may only transition COMPLETED -> VOIDED.', OLD."saleNumber";
    END IF;
    IF OLD."voidedByEntryId" IS NOT NULL THEN
      RAISE EXCEPTION 'Sale % is already voided.', OLD."saleNumber";
    END IF;
    IF NEW."voidedByEntryId" IS NULL THEN
      RAISE EXCEPTION 'Sale % void must set voidedByEntryId.', OLD."saleNumber";
    END IF;
    -- Task 6: see rule 2 in the note above this function.
    IF OLD."arReceived" > 0 THEN
      RAISE EXCEPTION
        'Sale % cannot be voided: % cents have already been received against its credit balance. Voiding would reverse the receivable while the receipt that settled it stands, leaving account 1100 with a credit balance nothing explains. Refund the customer with a separate document instead.',
        OLD."saleNumber", OLD."arReceived";
    END IF;
  ELSE
    -- status unchanged: the void marker fields must not change here.
    IF NEW."voidedByEntryId" IS DISTINCT FROM OLD."voidedByEntryId"
       OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"
    THEN
      RAISE EXCEPTION 'Sale % void fields may only change during the COMPLETED -> VOIDED transition.',
        OLD."saleNumber";
    END IF;
  END IF;

  -- Task 4.1: the fiscal transition table.
  IF NEW."fiscalStatus" IS DISTINCT FROM OLD."fiscalStatus" THEN
    IF OLD."fiscalStatus"::text = 'SIGNED' THEN
      RAISE EXCEPTION
        'Sale % is fiscally SIGNED and cannot change fiscal status: KRA holds the invoice. Reverse a signed sale with a CREDIT NOTE, never by downgrading it.',
        OLD."saleNumber";
    END IF;
    IF NOT (
      (OLD."fiscalStatus"::text = 'NOT_REQUESTED'
         AND NEW."fiscalStatus"::text IN ('PENDING_ETIMS', 'SIGNED', 'FAILED'))
      OR
      (OLD."fiscalStatus"::text = 'PENDING_ETIMS'
         AND NEW."fiscalStatus"::text IN ('SIGNED', 'FAILED'))
      OR
      (OLD."fiscalStatus"::text = 'FAILED'
         AND NEW."fiscalStatus"::text IN ('PENDING_ETIMS', 'SIGNED'))
    ) THEN
      RAISE EXCEPTION 'Sale % fiscal status may not move % -> %.',
        OLD."saleNumber", OLD."fiscalStatus", NEW."fiscalStatus";
    END IF;
  END IF;

  -- Task 6: the received receivable only ever goes UP. See rule 1 above.
  IF NEW."arReceived" < OLD."arReceived" THEN
    RAISE EXCEPTION
      'Sale % : the received receivable cannot decrease (% -> % cents). A customer receipt is an immutable posted fact; correct an erroneous one with a separate document, not by rewinding the sale.',
      OLD."saleNumber", OLD."arReceived", NEW."arReceived";
  END IF;

  -- paymentStatus is free to change (settlement lifecycle).
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
