-- ===========================================================================
-- THE JOB RUNS REGISTRY (M4.5 Wave 4). HAND-WRITTEN.
--
-- Every run of a maintenance job — triggered by the scheduler's protected endpoint or the CLI —
-- is a row here, so a run never silently disappears: it is RUNNING while it works and ends
-- SUCCEEDED or FAILED (with the reason); a run that found the job already running elsewhere is
-- recorded SKIPPED. `(jobName, idempotencyKey)` is UNIQUE: a scheduler that delivers the same
-- trigger twice gets the first run back and nothing runs again. Written ONLY by
-- src/services/jobs/runner.ts; read by platform staff.
--
--   born RUNNING (or SKIPPED, already finished);  RUNNING -> SUCCEEDED | FAILED;  terminal after.
-- ===========================================================================

CREATE TABLE "job_runs" (
  "id"             TEXT NOT NULL,
  "jobName"        TEXT NOT NULL,
  "trigger"        TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status"         TEXT NOT NULL,
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "summary"        JSONB,
  "error"          TEXT,
  "startedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"     TIMESTAMPTZ(3),
  CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "job_runs_trigger_known" CHECK ("trigger" IN ('SCHEDULER', 'CLI')),
  CONSTRAINT "job_runs_key_sane" CHECK (btrim("idempotencyKey") <> '' AND length("idempotencyKey") <= 200),
  CONSTRAINT "job_runs_attempts_bounded" CHECK ("attempts" BETWEEN 0 AND 10),
  CONSTRAINT "job_runs_status_coherent" CHECK (
    CASE "status"
      WHEN 'RUNNING'   THEN "finishedAt" IS NULL AND "error" IS NULL
      WHEN 'SUCCEEDED' THEN "finishedAt" IS NOT NULL AND "error" IS NULL AND "attempts" >= 1
      WHEN 'FAILED'    THEN "finishedAt" IS NOT NULL AND "error" IS NOT NULL AND btrim("error") <> ''
      WHEN 'SKIPPED'   THEN "finishedAt" IS NOT NULL AND "error" IS NOT NULL AND "attempts" = 0
      ELSE false
    END
  )
);
CREATE UNIQUE INDEX "job_runs_jobName_idempotencyKey_key" ON "job_runs"("jobName", "idempotencyKey");
CREATE INDEX "job_runs_jobName_startedAt_idx" ON "job_runs"("jobName", "startedAt");
CREATE INDEX "job_runs_status_idx" ON "job_runs"("status");

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
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'job_run_guard: which job ran, how and when can never change (%)', OLD."id" USING ERRCODE = 'check_violation';
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

CREATE TRIGGER job_run_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "job_runs"
  FOR EACH ROW EXECUTE FUNCTION public.job_run_guard();
