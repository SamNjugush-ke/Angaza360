-- ===========================================================================
-- Task T-A6.2 — a tenant application's decision is final, and coherent.
--
-- PENDING_APPROVAL -> APPROVED | REJECTED, both TERMINAL. Born PENDING_APPROVAL. Once
-- decided, nothing about the application changes, and it cannot be deleted: it is the
-- record of why a business was or was not onboarded. While PENDING its content may be
-- edited (a batch preview row is corrected in place) and it may be removed.
--
-- The RESTING STATE (CHECK, ending ELSE false): an APPROVED application names the tenant
-- it produced and when it was reviewed; a REJECTED one carries its reason and review
-- time; a PENDING one carries neither.
-- ===========================================================================

ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_application_decision_coherent" CHECK (
  CASE "status"::text
    WHEN 'PENDING_APPROVAL' THEN "reviewedAt" IS NULL AND "resultingTenantId" IS NULL AND "rejectionReason" IS NULL
    WHEN 'APPROVED' THEN "reviewedAt" IS NOT NULL AND "resultingTenantId" IS NOT NULL AND "rejectionReason" IS NULL
    WHEN 'REJECTED' THEN "reviewedAt" IS NOT NULL AND "resultingTenantId" IS NULL AND btrim(COALESCE("rejectionReason", '')) <> ''
    ELSE false
  END
);

CREATE OR REPLACE FUNCTION public.tenant_application_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'A tenant application is submitted PENDING_APPROVAL (got %).', NEW."status";
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status"::text <> 'PENDING_APPROVAL' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Tenant application % is %: a decided application is a permanent record and cannot be deleted.', OLD."id", OLD."status";
    END IF;
    RAISE EXCEPTION 'Tenant application % is %, which is final.', OLD."id", OLD."status";
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
     OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'Tenant application %: its source, batch and submission time never change.', OLD."id";
  END IF;
  IF NEW."status"::text NOT IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'Tenant application % may not move PENDING_APPROVAL -> %.', OLD."id", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_application_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."tenant_applications"
  FOR EACH ROW EXECUTE FUNCTION public.tenant_application_guard();
