-- ===========================================================================
-- 0033 — TERMINATION IS FINAL (Task T-B-EMP-TERMINATE-GUARD). HAND-WRITTEN.
--
-- The schema has always called EmployeeStatus.TERMINATED terminal, but nothing held it: an
-- employee could be terminated and then reinstated, rewriting the leaving date that a P9 and the
-- statutory filings are built on. Now, once an employee row is TERMINATED, its status and its
-- terminationDate are frozen; someone taken back on is a NEW employee record. SUSPENDED stays
-- reinstatable. The service refuses with a clean 409; THIS TRIGGER IS THE GUARANTEE. No existing
-- row is read or rewritten (it fires only on a later UPDATE).
-- ===========================================================================

CREATE OR REPLACE FUNCTION employee_terminated_final() RETURNS trigger AS $$
BEGIN
  IF OLD."status"::text = 'TERMINATED'
     AND (NEW."status"::text IS DISTINCT FROM OLD."status"::text OR NEW."terminationDate" IS DISTINCT FROM OLD."terminationDate") THEN
    RAISE EXCEPTION 'employee_terminated_final: employee % is TERMINATED; its status and termination date can no longer change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER employee_terminated_final
  BEFORE UPDATE ON "employees"
  FOR EACH ROW EXECUTE FUNCTION employee_terminated_final();
