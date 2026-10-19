-- ===========================================================================
-- 0026 — TENANT-EDITABLE STATUTORY CONFIG (Task 3B.3). HAND-WRITTEN.
--
-- Statutory rates become tenant-editable by SUPERSEDING, never by mutating: a change is
-- a NEW effective-dated version from a commencement date, and the currently-open
-- version is CLOSED to the day before. The no-overlap exclusion (0021) and the
-- freeze-once-used guard (0021/0024/0025) are what keep that safe. This migration adds
-- the audit column and the ONE guard refinement the model needs.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) WHO created a version. NULL on every existing row = the system seed.
-- ---------------------------------------------------------------------------
ALTER TABLE "statutory_schedules" ADD COLUMN "createdById" TEXT;

-- ---------------------------------------------------------------------------
-- (b) THE SCHEDULE GUARD, refined by exactly ONE permitted change on a USED version:
--     CLOSING an open-ended window — effectiveTo NULL -> D — provided no journal
--     entry is dated on or after D within the window and no live payroll run's period
--     starts on or after D.
--
-- WHY THIS IS NOT A WEAKENING. The guard exists so that no posted transaction ever
-- stops agreeing with the rates that governed it. Closing an open window at a date
-- BEYOND every transaction in it changes the governing schedule of no posted
-- transaction: everything already dated stays inside [effectiveFrom, D). What remains
-- frozen on a used version is everything that could change a posted figure — every
-- rate, the start date, and an end date once it is set (re-closing is refused, so a
-- closure cannot be walked backwards over transactions one step at a time). Closing
-- BEFORE a used date is refused, by this guard and by the service.
--
-- "Any journal entry" (not only POS) because VAT and TOT rates are read by sales,
-- supplier bills and ad-hoc receipts, all dated by entryDate; a payroll run is checked
-- by its PERIOD START, which is how it resolves its schedule. CANCELLED runs posted
-- nothing and do not pin the window.
--
-- Body is 0025's with the closure branch added. CREATE OR REPLACE keeps the binding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION statutory_schedule_guard() RETURNS trigger AS $$
DECLARE
  v_runs        integer;
  v_sales       integer;
  v_after_lines integer;
  v_after_runs  integer;
  v_closing     boolean;
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

    -- THE ONE PERMITTED WINDOW CHANGE (Task 3B.3): closing an open-ended window.
    v_closing := OLD."effectiveTo" IS NULL
                 AND NEW."effectiveTo" IS NOT NULL
                 AND NEW."effectiveFrom" IS NOT DISTINCT FROM OLD."effectiveFrom";
    IF v_closing THEN
      EXECUTE format(
        'SELECT count(*) FROM %I.journal_entries WHERE "entryDate" >= $1 AND "entryDate" >= $2',
        TG_TABLE_SCHEMA)
        INTO v_after_lines USING NEW."effectiveTo", OLD."effectiveFrom";
      EXECUTE format(
        'SELECT count(*) FROM %I.payroll_runs
          WHERE "statutoryScheduleId" = $1 AND "status"::text <> ''CANCELLED''
            AND make_date("periodYear", "periodMonth", 1) >= $2',
        TG_TABLE_SCHEMA)
        INTO v_after_runs USING OLD."id", NEW."effectiveTo";
      IF v_after_lines > 0 OR v_after_runs > 0 THEN
        RAISE EXCEPTION
          'Statutory schedule % cannot be closed at %: % journal entr(ies) and % payroll run(s) are dated on or after that day under it. A version may only be superseded FORWARD, after the last transaction it governed.',
          OLD."label", NEW."effectiveTo", v_after_lines, v_after_runs;
      END IF;
    ELSIF NEW."effectiveFrom"   IS DISTINCT FROM OLD."effectiveFrom"
       OR NEW."effectiveTo"     IS DISTINCT FROM OLD."effectiveTo"
    THEN
      RAISE EXCEPTION
        'Statutory schedule % is frozen: % payroll run(s) and % sale entr(ies) fall under it. Its window cannot change — except closing an open window after its last transaction; a rate change is a NEW dated schedule.',
        OLD."label", v_runs, v_sales;
    END IF;

    IF NEW."vatStandardRate"   IS DISTINCT FROM OLD."vatStandardRate"
       OR NEW."totRatePercent" IS DISTINCT FROM OLD."totRatePercent"
    THEN
      RAISE EXCEPTION
        'Statutory schedule % is frozen: % payroll run(s) and % sale entr(ies) fall under it. Its VAT and TOT rates cannot change; a rate change is a NEW dated schedule.',
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
