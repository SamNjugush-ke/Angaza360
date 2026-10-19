-- ===========================================================================
-- Task T-A4 — the identity audit log (platform schema). APPEND-ONLY.
--
-- The ONE audit table for identity events: T-A4 writes the password-lifecycle rows,
-- and T-A5 only ADDS AuditAction values (its own migration) and writes rows. The
-- database refuses UPDATE, DELETE and TRUNCATE — the same discipline as
-- mentorship_access_logs. actorUserId / targetUserId / tenantId are deliberately
-- NOT foreign keys: the record must outlive the user and the tenant it describes.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'PASSWORD_CHANGED');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actorUserId" TEXT,
    "targetUserId" TEXT,
    "tenantId" TEXT,
    "ipAddress" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_occurredAt_idx" ON "audit_logs"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetUserId_occurredAt_idx" ON "audit_logs"("targetUserId", "occurredAt");

CREATE OR REPLACE FUNCTION public.audit_log_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The identity audit log is append-only: % is refused. An audit record is never edited or removed.', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- Row level: every UPDATE and DELETE.
CREATE TRIGGER audit_log_guard_ud
  BEFORE UPDATE OR DELETE ON public."audit_logs"
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_guard();

-- Statement level: TRUNCATE fires no row trigger, so it is refused separately.
CREATE TRIGGER audit_log_guard_truncate
  BEFORE TRUNCATE ON public."audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_guard();
