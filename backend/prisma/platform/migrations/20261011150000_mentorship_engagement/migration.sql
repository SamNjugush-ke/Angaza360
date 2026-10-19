-- CreateEnum
CREATE TYPE "MentorshipEngagementStatus" AS ENUM ('INVITED', 'ACTIVE', 'ENDED');

-- CreateTable
CREATE TABLE "mentorship_engagements" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "MentorshipEngagementStatus" NOT NULL DEFAULT 'INVITED',
    "invitedById" TEXT NOT NULL,
    "consentGivenAt" TIMESTAMPTZ(3),
    "consentByUserId" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "endedReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mentorship_engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentorship_access_logs" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "viewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentorship_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mentorship_engagements_mentorId_idx" ON "mentorship_engagements"("mentorId");

-- CreateIndex
CREATE INDEX "mentorship_engagements_tenantId_idx" ON "mentorship_engagements"("tenantId");

-- CreateIndex
CREATE INDEX "mentorship_access_logs_engagementId_viewedAt_idx" ON "mentorship_access_logs"("engagementId", "viewedAt");

-- CreateIndex
CREATE INDEX "mentorship_access_logs_tenantId_viewedAt_idx" ON "mentorship_access_logs"("tenantId", "viewedAt");

-- AddForeignKey
ALTER TABLE "mentorship_engagements" ADD CONSTRAINT "mentorship_engagements_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_engagements" ADD CONSTRAINT "mentorship_engagements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_engagements" ADD CONSTRAINT "mentorship_engagements_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_engagements" ADD CONSTRAINT "mentorship_engagements_consentByUserId_fkey" FOREIGN KEY ("consentByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_access_logs" ADD CONSTRAINT "mentorship_access_logs_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "mentorship_engagements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_access_logs" ADD CONSTRAINT "mentorship_access_logs_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_access_logs" ADD CONSTRAINT "mentorship_access_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL (Task 14.1) — MUST NOT BE REGENERATED OR REMOVED.
--
-- The mentorship engagement is the gate for the ONE sanctioned cross-tenant READ in
-- this system (the engineering ledger "Mentorship"). Everything that makes that gate trustworthy is
-- held HERE, by the database, so it holds for every writer — not only for the service
-- that remembered to check. Platform tables live in `public`; references are qualified.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) AT MOST ONE LIVE ENGAGEMENT PER MENTOR-TENANT PAIR. Partial, so re-engaging
-- after ENDED is a new row and the old consent history is never overwritten.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX mentorship_engagement_one_live_per_pair
  ON public."mentorship_engagements" ("mentorId", "tenantId")
  WHERE "status" <> 'ENDED';

-- ---------------------------------------------------------------------------
-- (b) THE RESTING STATE each status must carry. ACTIVE without consent is
-- unrepresentable; INVITED carries no consent and no start; ENDED carries its end.
-- Fails closed (ELSE false), per the 0022 law on CASE CHECKs.
-- ---------------------------------------------------------------------------
ALTER TABLE public."mentorship_engagements" ADD CONSTRAINT mentorship_engagement_status_fields_coherent
  CHECK (
    CASE "status"::text
      WHEN 'INVITED' THEN "consentGivenAt" IS NULL AND "consentByUserId" IS NULL
                          AND "startedAt" IS NULL AND "endedAt" IS NULL
      WHEN 'ACTIVE'  THEN "consentGivenAt" IS NOT NULL AND "consentByUserId" IS NOT NULL
                          AND "startedAt" IS NOT NULL AND "endedAt" IS NULL
      WHEN 'ENDED'   THEN "endedAt" IS NOT NULL
                          AND ("consentGivenAt" IS NULL) = ("consentByUserId" IS NULL)
      ELSE false
    END
  );

-- ---------------------------------------------------------------------------
-- (c) THE ENGAGEMENT GUARD — who may be on an engagement, and how it may move.
--
-- INSERT: born INVITED; the mentor is a platform user (NO tenant) whose role is MENTOR
-- or COACH and who is active; the inviter is SUPER_ADMIN or PROGRAM_OFFICER; the
-- tenant exists.
--
-- UPDATE: identity (mentor, tenant, inviter, createdAt) is frozen forever.
--   INVITED -> ACTIVE  consent set IN THIS change, by an ACTIVE MSME_OWNER OF THIS TENANT
--   INVITED -> ENDED   (declined / withdrawn)
--   ACTIVE  -> ENDED
--   ENDED   -> nothing (terminal; the row is a historical record)
-- Consent, once given, is frozen: no one can rewrite who consented or when.
--
-- DELETE: refused. An engagement is the record that a business let someone read its
-- books; deleting it would erase that history (and its access log blocks it anyway).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mentorship_engagement_guard() RETURNS trigger AS $$
DECLARE
  v_role     text;
  v_tenant   text;
  v_active   boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Mentorship engagement % cannot be deleted: it is the record of a business''s consent to a mentor reading its books. End it instead.',
      OLD."id";
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'INVITED' THEN
      RAISE EXCEPTION 'A mentorship engagement must be created INVITED (got %): access begins only when the business consents.', NEW."status";
    END IF;
    SELECT "role"::text, "tenantId", "isActive" INTO v_role, v_tenant, v_active
      FROM public."users" WHERE "id" = NEW."mentorId";
    IF v_role IS NULL OR v_role NOT IN ('MENTOR', 'COACH') OR v_tenant IS NOT NULL OR NOT v_active THEN
      RAISE EXCEPTION 'Mentorship engagement mentor % must be an active platform user (no tenant) with role MENTOR or COACH (found role %, tenant %).',
        NEW."mentorId", COALESCE(v_role, 'none'), COALESCE(v_tenant, 'none');
    END IF;
    SELECT "role"::text INTO v_role FROM public."users" WHERE "id" = NEW."invitedById";
    IF v_role IS NULL OR v_role NOT IN ('SUPER_ADMIN', 'PROGRAM_OFFICER') THEN
      RAISE EXCEPTION 'Only a SUPER_ADMIN or PROGRAM_OFFICER may invite a mentor (inviter role %).', COALESCE(v_role, 'none');
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW."id"             IS DISTINCT FROM OLD."id"
     OR NEW."mentorId"    IS DISTINCT FROM OLD."mentorId"
     OR NEW."tenantId"    IS DISTINCT FROM OLD."tenantId"
     OR NEW."invitedById" IS DISTINCT FROM OLD."invitedById"
     OR NEW."createdAt"   IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Mentorship engagement %: its mentor, business, inviter and creation time can never change. A different relationship is a new engagement.', OLD."id";
  END IF;

  IF OLD."status"::text = 'ENDED' THEN
    RAISE EXCEPTION 'Mentorship engagement % is ENDED, which is terminal. Re-engaging is a new engagement (and a new consent).', OLD."id";
  END IF;

  IF OLD."consentGivenAt" IS NOT NULL
     AND (NEW."consentGivenAt" IS DISTINCT FROM OLD."consentGivenAt"
          OR NEW."consentByUserId" IS DISTINCT FROM OLD."consentByUserId")
  THEN
    RAISE EXCEPTION 'Mentorship engagement %: consent, once given, is a historical fact and cannot be rewritten.', OLD."id";
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status"::text = 'INVITED' AND NEW."status"::text = 'ACTIVE' THEN
      IF OLD."consentGivenAt" IS NOT NULL OR NEW."consentGivenAt" IS NULL OR NEW."consentByUserId" IS NULL THEN
        RAISE EXCEPTION 'Mentorship engagement % can become ACTIVE only with consent given in the same change.', OLD."id";
      END IF;
      SELECT "role"::text, "tenantId", "isActive" INTO v_role, v_tenant, v_active
        FROM public."users" WHERE "id" = NEW."consentByUserId";
      IF v_role IS DISTINCT FROM 'MSME_OWNER' OR v_tenant IS DISTINCT FROM OLD."tenantId" OR NOT COALESCE(v_active, false) THEN
        RAISE EXCEPTION 'Consent for mentorship engagement % must come from an active MSME_OWNER of the business being mentored.', OLD."id";
      END IF;
    ELSIF OLD."status"::text IN ('INVITED', 'ACTIVE') AND NEW."status"::text = 'ENDED' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Mentorship engagement % may not move % -> %.', OLD."id", OLD."status", NEW."status";
    END IF;
  ELSIF NEW."consentGivenAt" IS DISTINCT FROM OLD."consentGivenAt"
        OR NEW."consentByUserId" IS DISTINCT FROM OLD."consentByUserId"
        OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
        OR NEW."endedAt" IS DISTINCT FROM OLD."endedAt"
  THEN
    RAISE EXCEPTION 'Mentorship engagement %: consent, start and end are set only by a status transition.', OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mentorship_engagement_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."mentorship_engagements"
  FOR EACH ROW EXECUTE FUNCTION public.mentorship_engagement_guard();

-- ---------------------------------------------------------------------------
-- (d) THE ACCESS LOG — APPEND-ONLY, and a row may only record a read through an
-- ACTIVE engagement by ITS OWN mentor of ITS OWN tenant. So the log can never claim a
-- read the gate would not have allowed, and no one can edit or erase what was read.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mentorship_access_log_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_mentor text;
  v_tenant text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'The mentorship access log is append-only: entry % cannot be % — it is the business''s record of who read its books.',
      OLD."id", lower(TG_OP);
  END IF;
  SELECT "status"::text, "mentorId", "tenantId" INTO v_status, v_mentor, v_tenant
    FROM public."mentorship_engagements" WHERE "id" = NEW."engagementId";
  IF v_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'A mentor read can be logged only through an ACTIVE engagement (engagement % is %).', NEW."engagementId", COALESCE(v_status, 'missing');
  END IF;
  IF NEW."mentorId" IS DISTINCT FROM v_mentor OR NEW."tenantId" IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'An access-log entry must name its engagement''s own mentor and business.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mentorship_access_log_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."mentorship_access_logs"
  FOR EACH ROW EXECUTE FUNCTION public.mentorship_access_log_guard();
