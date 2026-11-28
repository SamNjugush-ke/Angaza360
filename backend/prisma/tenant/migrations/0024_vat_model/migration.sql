-- CreateEnum
CREATE TYPE "TaxClass" AS ENUM ('STANDARD_RATED', 'ZERO_RATED', 'EXEMPT');

-- CreateEnum
CREATE TYPE "KraTaxCode" AS ENUM ('A', 'B', 'C', 'D');

-- ===========================================================================
-- 0024 — THE VAT MODEL (Task 3B.1). HAND-WRITTEN BELOW THE ENUMS.
--
-- Before this migration every product carried `taxRate` (all 16.00) and the POS
-- charged output VAT to 2100 from it WHATEVER the tenant's VAT registration — so a
-- Turnover Tax business charged its customers VAT it had no right to collect. After
-- it:
--
--   * a product carries a TAX CLASS (standard-rated / zero-rated / exempt), not a rate;
--   * the standard rate is CONFIGURATION on the effective-dated StatutorySchedule,
--     verified and cited, and is the ONLY copy of that figure in the system;
--   * each sale line records its class and the KRA tax-type code it was charged under.
--
-- FORWARD-ONLY. No sale, sale line, journal entry or 2100 balance is touched: the new
-- sale-line columns are NULL on every existing line, and NULL MEANS STANDARD_RATED /
-- code B — which is the literal truth, because every product was 16% standard-rated
-- until now (asserted below, not assumed).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) PRODUCT: taxRate -> taxClass.
--
-- Every existing product becomes STANDARD_RATED. That mapping is only honest if every
-- product IS at the standard rate, so this REFUSES rather than guesses if any product
-- carries another rate: a zero-rated or exempt item silently reclassified as standard
-- would start charging 16% VAT at the till.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_other bigint;
BEGIN
  SELECT count(*) INTO v_other FROM "products" WHERE "taxRate" <> 16.00;
  IF v_other > 0 THEN
    RAISE EXCEPTION
      '0024: % product(s) carry a VAT rate other than 16.00. They cannot be classified STANDARD_RATED automatically; set each one''s tax class deliberately before re-running.',
      v_other;
  END IF;
END $$;

ALTER TABLE "products" ADD COLUMN "taxClass" "TaxClass" NOT NULL DEFAULT 'STANDARD_RATED';
ALTER TABLE "products" DROP COLUMN "taxRate";

-- ---------------------------------------------------------------------------
-- (b) STATUTORY SCHEDULE: the standard VAT rate, with its own provenance.
--
-- VERIFIED 2026-10-11: VAT Act No. 35 of 2013, s.5(2)(b) — 16% of the taxable value
-- of a taxable supply (KRA). Zero-rated supplies (Second Schedule) are 0%; exempt
-- supplies (First Schedule) are outside VAT. A 2026 budget proposal to cut the rate to
-- 15% was NOT enacted as at the verification date. The provenance is recorded in its
-- own columns rather than appended to the payroll `source`, because it was verified
-- on a different day against a different statute.
--
-- Added with a temporary default so every existing schedule row is filled in this
-- statement; the default is then dropped, so a NEW schedule must state its rate.
-- ---------------------------------------------------------------------------
ALTER TABLE "statutory_schedules"
  ADD COLUMN "vatStandardRate"   DECIMAL(5,2) NOT NULL DEFAULT 16.00,
  ADD COLUMN "vatRateSource"     TEXT NOT NULL DEFAULT 'VAT Act No. 35 of 2013, s.5(2)(b): the standard rate is 16% of the taxable value of a taxable supply (KRA, kra.go.ke — Value Added Tax). Zero-rated supplies (Second Schedule) 0%; exempt supplies (First Schedule) outside VAT. A 2026 budget proposal to reduce the rate to 15% was not enacted as at verification. Verified 2026-10-11.',
  ADD COLUMN "vatRateVerifiedOn" DATE NOT NULL DEFAULT DATE '2026-10-11';

ALTER TABLE "statutory_schedules"
  ALTER COLUMN "vatStandardRate" DROP DEFAULT,
  ALTER COLUMN "vatRateSource" DROP DEFAULT,
  ALTER COLUMN "vatRateVerifiedOn" DROP DEFAULT;

ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_vat_rate_is_a_percentage
  CHECK ("vatStandardRate" > 0 AND "vatStandardRate" <= 100);

ALTER TABLE "statutory_schedules" ADD CONSTRAINT statutory_schedule_vat_source_recorded
  CHECK (btrim("vatRateSource") <> '');

-- ---------------------------------------------------------------------------
-- (c) THE SCHEDULE GUARD, extended to the VAT rate.
--
-- 0021 froze a schedule's payroll figures once a payroll RUN had used it. The VAT
-- rate is used by SALES, which do not reference a schedule id — a sale uses the
-- schedule whose window contains its business date. So a schedule is also "used" once
-- any POS journal entry is dated inside its window, and from then on its VAT rate and
-- its window are frozen: editing either would make posted sales disagree with the rate
-- that governed them. A rate change is a NEW dated schedule, never an edit — the same
-- rule 0021 states for payroll. CREATE OR REPLACE keeps the existing trigger binding.
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
    THEN
      RAISE EXCEPTION
        'Statutory schedule % is frozen: % payroll run(s) and % sale entr(ies) fall under it. Its window and VAT rate cannot change; a rate change is a NEW dated schedule.',
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
-- (d) SALE LINES: the class and the KRA code each line was charged under.
--
-- NULL on every existing line (= STANDARD_RATED / B, see the header). From 0024 on,
-- the sale path writes both, and the CHECKs below make a self-contradicting line
-- unrepresentable even if inserted directly:
--   B  standard-rated, a positive rate
--   C  zero-rated, rate 0, no VAT
--   A  exempt, rate 0, no VAT
--   D  non-VAT (the seller is not VAT-registered): rate 0, no VAT, any class
-- Sale lines stay immutable (0006's trigger), so the snapshot can never be restated.
-- ---------------------------------------------------------------------------
ALTER TABLE "sale_lines"
  ADD COLUMN "taxClass" "TaxClass",
  ADD COLUMN "taxCode"  "KraTaxCode";

ALTER TABLE "sale_lines" ADD CONSTRAINT sale_line_tax_snapshot_complete
  CHECK (("taxClass" IS NULL) = ("taxCode" IS NULL));

ALTER TABLE "sale_lines" ADD CONSTRAINT sale_line_tax_code_coherent
  CHECK (
    "taxCode" IS NULL
    OR CASE "taxCode"::text
         WHEN 'B' THEN "taxClass"::text = 'STANDARD_RATED' AND "vatRate" > 0
         WHEN 'C' THEN "taxClass"::text = 'ZERO_RATED' AND "vatRate" = 0 AND "lineVat" = 0
         WHEN 'A' THEN "taxClass"::text = 'EXEMPT' AND "vatRate" = 0 AND "lineVat" = 0
         WHEN 'D' THEN "vatRate" = 0 AND "lineVat" = 0
         ELSE false
       END
  );

-- ---------------------------------------------------------------------------
-- (e) BUSINESS PROFILE: drop `defaultVatRate`.
--
-- The national standard rate now lives on the effective-dated schedule, and two
-- writable copies of the figure that decides every invoice's VAT is how a tenant ends
-- up charging one rate and recovering another. Its CHECK goes with it. The regime
-- (`taxRegime` / `isVatRegistered`) stays here: WHETHER a tenant charges VAT is the
-- tenant's fact; WHAT the rate is, is the law's.
-- ---------------------------------------------------------------------------
ALTER TABLE "business_profile" DROP COLUMN "defaultVatRate";
