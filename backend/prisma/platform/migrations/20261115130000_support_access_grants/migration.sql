-- ===========================================================================
-- M4.5 Wave 1 — SUPPORT-ACCESS GRANTS (platform schema).
--
-- Outside a grant a platform administrator has NO access to a business's data beyond
-- platform aggregates. A grant scopes ONE administrator to ONE business for a short,
-- fixed window, with a reason on record:
--   * created only by an ACTIVE SUPER_ADMIN, for an ACTIVE SUPER_ADMIN or PROGRAM_OFFICER;
--     MODIFY scope only for a SUPER_ADMIN; never for a DEACTIVATED business;
--   * the window is fixed at creation and at most 8 hours long;
--   * everything about it is frozen, except: revocation (once), the owner-notification
--     stamp (once), and the access counter + chain head, which only move forward and only
--     while the grant is LIVE — so a revoked or expired grant cannot be used, even by a
--     writer that bypasses the service;
--   * a grant is never deleted: it is the record of why someone looked.
-- Each access is an append-only, hash-chained row in audit_logs (SUPPORT_ACCESS_USED);
-- accessCount and lastAccessHash are the chain's head, so a removed or altered entry is
-- detectable. The user and tenant columns are PLAIN ids with no foreign key, like the
-- audit log's: the record of who was given access to what must outlive both.
-- ===========================================================================

CREATE TYPE "SupportAccessScope" AS ENUM ('VIEW', 'MODIFY');

CREATE TABLE "support_access_grants" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "scope" "SupportAccessScope" NOT NULL,
    "reason" TEXT NOT NULL,
    "caseRef" TEXT,
    "purpose" TEXT,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "ownerNotifiedAt" TIMESTAMPTZ(3),
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessHash" TEXT,

    CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_access_grants_adminUserId_idx" ON "support_access_grants"("adminUserId");
CREATE INDEX "support_access_grants_tenantId_idx" ON "support_access_grants"("tenantId");

ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_grant_reason_present"
  CHECK (length(btrim("reason")) BETWEEN 5 AND 1000);
-- TIME-LIMITED: the window is positive and at most 8 hours.
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_grant_window_bounded"
  CHECK ("expiresAt" > "grantedAt" AND "expiresAt" <= "grantedAt" + interval '8 hours');
-- A revocation names its revoker, and only a revoked grant carries a revoke reason.
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_grant_revocation_coherent"
  CHECK (("revokedAt" IS NULL AND "revokedById" IS NULL AND "revokeReason" IS NULL)
         OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL));
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_grant_chain_coherent"
  CHECK ("accessCount" >= 0 AND (("accessCount" = 0) = ("lastAccessHash" IS NULL))
         AND ("lastAccessHash" IS NULL OR "lastAccessHash" ~ '^[0-9a-f]{64}$'));

CREATE OR REPLACE FUNCTION public.support_access_grant_guard() RETURNS trigger AS $$
DECLARE
  v_admin_role text;
  v_admin_active boolean;
  v_admin_tenant text;
  v_creator_role text;
  v_creator_active boolean;
  v_tenant_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Support-access grant %: a grant is never deleted — it is the record of why someone looked.', OLD."id";
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT "role"::text, "isActive", "tenantId" INTO v_admin_role, v_admin_active, v_admin_tenant
      FROM public."users" WHERE "id" = NEW."adminUserId";
    SELECT "role"::text, "isActive" INTO v_creator_role, v_creator_active
      FROM public."users" WHERE "id" = NEW."createdById";
    SELECT "status"::text INTO v_tenant_status FROM public."tenants" WHERE "id" = NEW."tenantId";
    IF v_creator_role IS DISTINCT FROM 'SUPER_ADMIN' OR NOT v_creator_active THEN
      RAISE EXCEPTION 'Only an active SUPER_ADMIN may create a support-access grant.';
    END IF;
    IF v_admin_role NOT IN ('SUPER_ADMIN', 'PROGRAM_OFFICER') OR NOT v_admin_active OR v_admin_tenant IS NOT NULL THEN
      RAISE EXCEPTION 'A support-access grant is for an active platform administrator (SUPER_ADMIN or PROGRAM_OFFICER) only.';
    END IF;
    IF NEW."scope"::text = 'MODIFY' AND v_admin_role <> 'SUPER_ADMIN' THEN
      RAISE EXCEPTION 'MODIFY support access may be granted only to a SUPER_ADMIN.';
    END IF;
    IF v_tenant_status IS NULL OR v_tenant_status = 'DEACTIVATED' THEN
      RAISE EXCEPTION 'Support access cannot be granted to a deactivated or unknown business.';
    END IF;
    IF NEW."revokedAt" IS NOT NULL OR NEW."ownerNotifiedAt" IS NOT NULL OR NEW."accessCount" <> 0 THEN
      RAISE EXCEPTION 'A support-access grant must be created live, unnotified and unused.';
    END IF;
    IF NEW."grantedAt" < clock_timestamp() - interval '1 minute' THEN
      RAISE EXCEPTION 'A support-access grant cannot be back-dated.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: what the grant IS can never change.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."adminUserId" IS DISTINCT FROM OLD."adminUserId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."caseRef" IS DISTINCT FROM OLD."caseRef"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'Support-access grant %: its admin, business, scope, reason and window can never change (revoke it and grant anew).', OLD."id";
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
     OR NEW."revokedById" IS DISTINCT FROM OLD."revokedById" OR NEW."revokeReason" IS DISTINCT FROM OLD."revokeReason") THEN
    RAISE EXCEPTION 'Support-access grant % is already revoked; a revocation is final.', OLD."id";
  END IF;
  IF OLD."ownerNotifiedAt" IS NOT NULL AND NEW."ownerNotifiedAt" IS DISTINCT FROM OLD."ownerNotifiedAt" THEN
    RAISE EXCEPTION 'Support-access grant %: the owner-notification stamp is set once.', OLD."id";
  END IF;
  IF NEW."accessCount" IS DISTINCT FROM OLD."accessCount" OR NEW."lastAccessHash" IS DISTINCT FROM OLD."lastAccessHash" THEN
    IF NEW."accessCount" <> OLD."accessCount" + 1 OR NEW."lastAccessHash" IS NOT DISTINCT FROM OLD."lastAccessHash" THEN
      RAISE EXCEPTION 'Support-access grant %: the access chain only advances, one entry at a time.', OLD."id";
    END IF;
    IF OLD."revokedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR clock_timestamp() >= OLD."expiresAt" OR clock_timestamp() < OLD."grantedAt" THEN
      RAISE EXCEPTION 'Support-access grant % is not live (revoked or outside its window); it cannot be used.', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER support_access_grant_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."support_access_grants"
  FOR EACH ROW EXECUTE FUNCTION public.support_access_grant_guard();
