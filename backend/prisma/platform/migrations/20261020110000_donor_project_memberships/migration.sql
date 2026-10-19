-- ===========================================================================
-- Task T-A12 — donor-project memberships and their CONSENT (platform schema).
--
-- A member business is in its cohort's AGGREGATE only while CONSENTED, and consent is
-- the BUSINESS's to give — the Module 14 rule, held here by the database:
--   * a membership is born PENDING, and only into an ACTIVE project;
--   * PENDING -> CONSENTED | WITHDRAWN, CONSENTED -> WITHDRAWN, WITHDRAWN -> CONSENTED;
--     every consent change names an ACTIVE MSME_OWNER OF THAT BUSINESS and when;
--   * nothing about a membership changes once its project is CLOSED;
--   * which project and which business never change.
-- Removing a membership (DELETE) is allowed — an admin removing a business, or the
-- business itself being dropped (cascade) — and leaves the access log untouched.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "DonorConsentStatus" AS ENUM ('PENDING', 'CONSENTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "donor_project_memberships" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consentStatus" "DonorConsentStatus" NOT NULL DEFAULT 'PENDING',
    "consentByUserId" TEXT,
    "consentAt" TIMESTAMPTZ(3),
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donor_project_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "donor_project_memberships_tenantId_idx" ON "donor_project_memberships"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "donor_project_memberships_projectId_tenantId_key" ON "donor_project_memberships"("projectId", "tenantId");

-- AddForeignKey
ALTER TABLE "donor_project_memberships" ADD CONSTRAINT "donor_project_memberships_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "donor_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donor_project_memberships" ADD CONSTRAINT "donor_project_memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The RESTING STATE: PENDING carries no consent; CONSENTED and WITHDRAWN name who and when.
ALTER TABLE "donor_project_memberships" ADD CONSTRAINT "donor_membership_consent_coherent" CHECK (
  CASE "consentStatus"::text
    WHEN 'PENDING' THEN "consentByUserId" IS NULL AND "consentAt" IS NULL
    WHEN 'CONSENTED' THEN "consentByUserId" IS NOT NULL AND "consentAt" IS NOT NULL
    WHEN 'WITHDRAWN' THEN "consentByUserId" IS NOT NULL AND "consentAt" IS NOT NULL
    ELSE false
  END
);

CREATE OR REPLACE FUNCTION public.donor_membership_guard() RETURNS trigger AS $$
DECLARE
  v_project_status text;
  v_owner_ok       boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT p."status"::text INTO v_project_status FROM public."donor_projects" p WHERE p."id" = NEW."projectId";

  IF TG_OP = 'INSERT' THEN
    IF NEW."consentStatus"::text <> 'PENDING' THEN
      RAISE EXCEPTION 'A business joins a donor project PENDING its own consent (got %).', NEW."consentStatus";
    END IF;
    IF v_project_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'A business can join only an ACTIVE donor project.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."joinedAt" IS DISTINCT FROM OLD."joinedAt" THEN
    RAISE EXCEPTION 'Donor membership %: its project, business and join time never change.', OLD."id";
  END IF;
  IF v_project_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Donor membership %: its project is closed; consent no longer changes.', OLD."id";
  END IF;

  IF NEW."consentStatus" IS DISTINCT FROM OLD."consentStatus"
     OR NEW."consentByUserId" IS DISTINCT FROM OLD."consentByUserId"
     OR NEW."consentAt" IS DISTINCT FROM OLD."consentAt" THEN
    IF NEW."consentStatus"::text = 'PENDING' THEN
      RAISE EXCEPTION 'Donor membership %: consent cannot return to PENDING.', OLD."id";
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public."users" u
       WHERE u."id" = NEW."consentByUserId"
         AND u."tenantId" = NEW."tenantId"
         AND u."role" = 'MSME_OWNER'
         AND u."isActive"
    ) INTO v_owner_ok;
    IF NOT v_owner_ok THEN
      RAISE EXCEPTION 'Consent for donor membership % must come from an active MSME_OWNER of the business itself.', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER donor_membership_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."donor_project_memberships"
  FOR EACH ROW EXECUTE FUNCTION public.donor_membership_guard();
