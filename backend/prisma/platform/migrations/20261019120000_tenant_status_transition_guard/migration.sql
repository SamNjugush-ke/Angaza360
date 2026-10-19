-- ===========================================================================
-- Task T-A6.1 — the tenant LIFECYCLE, held by the database.
--
--   PENDING_PROVISIONING -> ACTIVE          (provisioning completes)
--   ACTIVE               -> SUSPENDED       (locks the business's users out)
--   SUSPENDED            -> ACTIVE          (lifts it)
--   ACTIVE | SUSPENDED   -> DEACTIVATED     (TERMINAL)
--
-- Any other change of status is refused, whoever writes it. The service answers the
-- same question first with a clean 409; this trigger is the guarantee. An UPDATE that
-- leaves the status unchanged is not a transition and is not refused.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.tenant_status_transition_guard() RETURNS trigger AS $$
DECLARE
  v_from text := OLD."status"::text;
  v_to   text := NEW."status"::text;
BEGIN
  IF v_from = v_to THEN
    RETURN NEW;
  END IF;
  IF (v_from = 'PENDING_PROVISIONING' AND v_to = 'ACTIVE')
     OR (v_from = 'ACTIVE' AND v_to = 'SUSPENDED')
     OR (v_from = 'SUSPENDED' AND v_to = 'ACTIVE')
     OR (v_from IN ('ACTIVE', 'SUSPENDED') AND v_to = 'DEACTIVATED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Tenant %: the status may not move % -> %. DEACTIVATED is terminal.', OLD."subdomain", v_from, v_to;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_status_transition_guard_u
  BEFORE UPDATE OF "status" ON public."tenants"
  FOR EACH ROW EXECUTE FUNCTION public.tenant_status_transition_guard();
