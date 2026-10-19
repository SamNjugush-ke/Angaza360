-- ===========================================================================
-- Task T-A12 — the donor-cohort ACCESS LOG (platform schema). APPEND-ONLY.
--
-- Every read of a member business's books for a cohort aggregate is one row — who read,
-- which business, which project, what, when — written BEFORE the data is returned, by the
-- shared read-only gate. Mirrors mentorship_access_logs:
--   * a row is admitted ONLY for a CONSENTED member of an ACTIVE project — the database
--     refuses a log (and so a read) of anyone else;
--   * UPDATE, DELETE and TRUNCATE are refused.
-- Plain ids, no foreign keys: the record outlives the reader and the business.
-- ===========================================================================

-- CreateTable
CREATE TABLE "donor_access_logs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "readerUserId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "viewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donor_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "donor_access_logs_projectId_viewedAt_idx" ON "donor_access_logs"("projectId", "viewedAt");

-- CreateIndex
CREATE INDEX "donor_access_logs_tenantId_viewedAt_idx" ON "donor_access_logs"("tenantId", "viewedAt");

CREATE OR REPLACE FUNCTION public.donor_access_log_guard() RETURNS trigger AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM public."donor_project_memberships" m
        JOIN public."donor_projects" p ON p."id" = m."projectId"
       WHERE m."projectId" = NEW."projectId"
         AND m."tenantId" = NEW."tenantId"
         AND m."consentStatus" = 'CONSENTED'
         AND p."status" = 'ACTIVE'
    ) INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'A cohort read can be logged only for a CONSENTED member of an ACTIVE donor project.';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The donor access log is append-only: % is refused — it is the business''s record of who read its books.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER donor_access_log_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."donor_access_logs"
  FOR EACH ROW EXECUTE FUNCTION public.donor_access_log_guard();

CREATE TRIGGER donor_access_log_guard_truncate
  BEFORE TRUNCATE ON public."donor_access_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.donor_access_log_guard();
