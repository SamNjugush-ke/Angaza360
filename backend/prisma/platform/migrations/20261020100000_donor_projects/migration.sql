-- ===========================================================================
-- Task T-A12 — donor projects / cohorts (platform schema).
--
-- A donor-funded programme. ACTIVE -> CLOSED once, terminal (CLOSED carries its close
-- time); its code, donor, creator and creation time never change; it is never deleted
-- (memberships and access-log rows refer to it).
-- ===========================================================================

-- CreateEnum
CREATE TYPE "DonorProjectStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "donor_projects" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "donor" TEXT NOT NULL,
    "description" TEXT,
    "status" "DonorProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "donor_projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "donor_projects_code_key" ON "donor_projects"("code");

ALTER TABLE "donor_projects" ADD CONSTRAINT "donor_project_status_coherent" CHECK (
  CASE "status"::text
    WHEN 'ACTIVE' THEN "closedAt" IS NULL
    WHEN 'CLOSED' THEN "closedAt" IS NOT NULL
    ELSE false
  END
);

CREATE OR REPLACE FUNCTION public.donor_project_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'ACTIVE' THEN
      RAISE EXCEPTION 'A donor project is created ACTIVE (got %).', NEW."status";
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Donor project % cannot be deleted: close it.', OLD."code";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."donor" IS DISTINCT FROM OLD."donor"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Donor project %: its code, donor, creator and creation time never change.', OLD."code";
  END IF;
  IF OLD."status"::text = 'CLOSED' THEN
    RAISE EXCEPTION 'Donor project % is CLOSED, which is final.', OLD."code";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER donor_project_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."donor_projects"
  FOR EACH ROW EXECUTE FUNCTION public.donor_project_guard();
