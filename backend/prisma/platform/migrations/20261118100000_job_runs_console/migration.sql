-- ===========================================================================
-- CONSOLE RUNS (M4.5 Wave 5). HAND-WRITTEN.
--
-- A SUPER_ADMIN may start a job from the Command Center (POST /v1/jobs/{name}/run, behind an MFA
-- step-up). Such a run is recorded trigger 'CONSOLE' and names the administrator in "requestedBy".
-- A machine run (SCHEDULER) or an operator's CLI run names nobody. Both directions are held:
-- CONSOLE <=> requestedBy present. "requestedBy" is frozen like the rest of the run's identity
-- (job_run_guard replaced). No existing row changes: every one is SCHEDULER or CLI with no requester.
-- ===========================================================================

ALTER TABLE "job_runs" ADD COLUMN "requestedBy" TEXT;
ALTER TABLE "job_runs" DROP CONSTRAINT "job_runs_trigger_known";
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_trigger_known" CHECK ("trigger" IN ('SCHEDULER', 'CLI', 'CONSOLE'));
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_console_names_requester" CHECK (("trigger" = 'CONSOLE') = ("requestedBy" IS NOT NULL));

CREATE OR REPLACE FUNCTION public.job_run_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'job_run_guard: a job run is the record of what ran; it is never deleted (%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('RUNNING', 'SKIPPED') THEN
      RAISE EXCEPTION 'job_run_guard: a run is born RUNNING or SKIPPED (got %)', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."jobName" IS DISTINCT FROM OLD."jobName" OR NEW."trigger" IS DISTINCT FROM OLD."trigger"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy" THEN
    RAISE EXCEPTION 'job_run_guard: which job ran, how, by whom and when can never change (%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'RUNNING' THEN
    RAISE EXCEPTION 'job_run_guard: run % is %, which is final', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('RUNNING', 'SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'job_run_guard: a run may not move RUNNING -> %', NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'job_run_guard: attempts only rise' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
