-- ===========================================================================
-- Task T-A3 — notification delivery record (platform schema).
--
-- One row per message the platform sends. The BODY is deliberately not stored: a
-- rendered body can carry a raw single-use token (a password-reset code, an invite
-- token), and those exist only as hashes server-side.
-- ===========================================================================
-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SIMULATED');

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "providerName" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_logs_relatedType_relatedId_idx" ON "notification_logs"("relatedType", "relatedId");

-- CreateIndex
CREATE INDEX "notification_logs_createdAt_idx" ON "notification_logs"("createdAt");


-- The RESTING STATE: each status carries exactly the fields it should. A CASE CHECK
-- ends ELSE false (the engineering ledger "Working Practices") so a future status fails closed.
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_log_status_coherent" CHECK (
  CASE "status"::text
    WHEN 'QUEUED'    THEN "sentAt" IS NULL AND "error" IS NULL
    WHEN 'SENT'      THEN "sentAt" IS NOT NULL AND "error" IS NULL
    WHEN 'SIMULATED' THEN "sentAt" IS NOT NULL AND "error" IS NULL
    WHEN 'FAILED'    THEN "error" IS NOT NULL AND "sentAt" IS NULL
    ELSE false
  END
);

-- TRANSITIONS: born QUEUED; QUEUED -> SENT | FAILED | SIMULATED exactly once; every
-- outcome is terminal; what was sent, to whom, and why are frozen.
CREATE OR REPLACE FUNCTION public.notification_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'QUEUED' THEN
      RAISE EXCEPTION 'A notification is recorded QUEUED before it is sent (got %).', NEW."status";
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."recipient" IS DISTINCT FROM OLD."recipient"
     OR NEW."templateKey" IS DISTINCT FROM OLD."templateKey"
     OR NEW."relatedType" IS DISTINCT FROM OLD."relatedType"
     OR NEW."relatedId" IS DISTINCT FROM OLD."relatedId"
     OR NEW."providerName" IS DISTINCT FROM OLD."providerName"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Notification %: what was sent, to whom and through which provider can never change.', OLD."id";
  END IF;

  IF OLD."status"::text <> 'QUEUED' THEN
    RAISE EXCEPTION 'Notification % is %, which is terminal.', OLD."id", OLD."status";
  END IF;
  IF NEW."status"::text NOT IN ('SENT', 'FAILED', 'SIMULATED') THEN
    RAISE EXCEPTION 'Notification % may not move QUEUED -> %.', OLD."id", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_log_guard_iu
  BEFORE INSERT OR UPDATE ON public."notification_logs"
  FOR EACH ROW EXECUTE FUNCTION public.notification_log_guard();
