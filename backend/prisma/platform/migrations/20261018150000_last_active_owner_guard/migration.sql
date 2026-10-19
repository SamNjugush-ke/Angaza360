-- ===========================================================================
-- Task T-A5 — FAIL-CLOSED: a tenant never loses its last active MSME_OWNER.
--
-- The service refuses (409) to deactivate or demote the last active owner; THIS is the
-- guarantee behind it, for every writer including raw SQL. It fires only when an
-- ACTIVE MSME_OWNER of a tenant stops being one (deactivated, demoted or moved out),
-- and refuses unless another active owner of that tenant remains.
--
-- Concurrency: two owners demoting each other at once could each see the other still
-- active. So the check first takes a NO KEY UPDATE lock on the TENANT row — a
-- per-tenant mutex that does not conflict with foreign-key checks — and, under READ
-- COMMITTED, the count that follows sees whatever the other transaction committed.
--
-- DELETE is not guarded: removing a whole tenant cascades its users, and deleting a
-- user row is not a staff-management operation (deactivation is).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.last_active_owner_guard() RETURNS trigger AS $$
DECLARE
  v_remaining integer;
BEGIN
  IF OLD."tenantId" IS NULL OR OLD."role"::text <> 'MSME_OWNER' OR NOT OLD."isActive" THEN
    RETURN NEW;
  END IF;
  IF NEW."role"::text = 'MSME_OWNER' AND NEW."isActive" AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM public."tenants" t WHERE t."id" = OLD."tenantId" FOR NO KEY UPDATE;

  SELECT count(*) INTO v_remaining
    FROM public."users" u
   WHERE u."tenantId" = OLD."tenantId"
     AND u."role" = 'MSME_OWNER'
     AND u."isActive"
     AND u."id" <> OLD."id";
  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'User % is the last active MSME_OWNER of tenant %: a business cannot be left without an owner. Add or reactivate another owner first.',
      OLD."id", OLD."tenantId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER last_active_owner_guard_u
  BEFORE UPDATE OF "role", "isActive", "tenantId" ON public."users"
  FOR EACH ROW EXECUTE FUNCTION public.last_active_owner_guard();
