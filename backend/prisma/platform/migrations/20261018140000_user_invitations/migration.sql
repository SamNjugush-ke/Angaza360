-- ===========================================================================
-- Task T-A5 — staff invitations (platform schema).
--
-- An invitation GRANTS A ROLE, so the database holds the role-assignment rules too:
--   * a PLATFORM role (SUPER_ADMIN, PROGRAM_OFFICER, MENTOR, COACH) is tenantless, and a
--     tenant role belongs to exactly one tenant (CHECK);
--   * only a SUPER_ADMIN may invite to a platform role or into any tenant; an active
--     MSME_OWNER may invite to a TENANT role in THEIR OWN tenant; nobody else may
--     invite at all (guard trigger, on INSERT) — so privilege escalation is refused
--     even for a write that bypasses the service.
-- The token is stored only as its sha256 hex. PENDING -> ACCEPTED | REVOKED | EXPIRED,
-- all terminal; what was offered, to whom and by whom is frozen; at most ONE PENDING
-- invitation per email.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "user_invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "tenantId" TEXT,
    "invitedById" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_invitations_tokenHash_key" ON "user_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "user_invitations_tenantId_createdAt_idx" ON "user_invitations"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "user_invitations_email_idx" ON "user_invitations"("email");

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most ONE open invitation per email address.
CREATE UNIQUE INDEX "user_invitations_one_pending_per_email" ON "user_invitations"("email") WHERE "status" = 'PENDING';

ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitation_token_hash_is_sha256"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- Emails are compared normalized; store them that way.
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitation_email_normalized"
  CHECK ("email" = lower(btrim("email")) AND "email" <> '');

-- A platform role is tenantless; a tenant role belongs to exactly one tenant.
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitation_role_matches_tenancy"
  CHECK (("role"::text IN ('SUPER_ADMIN', 'PROGRAM_OFFICER', 'MENTOR', 'COACH')) = ("tenantId" IS NULL));

ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitation_expires_after_creation"
  CHECK ("expiresAt" > "createdAt");

-- The RESTING STATE of each status; a CASE CHECK ends ELSE false.
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitation_status_coherent" CHECK (
  CASE "status"::text
    WHEN 'PENDING'  THEN "acceptedAt" IS NULL AND "acceptedUserId" IS NULL
    WHEN 'ACCEPTED' THEN "acceptedAt" IS NOT NULL AND "acceptedUserId" IS NOT NULL
    WHEN 'REVOKED'  THEN "acceptedAt" IS NULL AND "acceptedUserId" IS NULL
    WHEN 'EXPIRED'  THEN "acceptedAt" IS NULL AND "acceptedUserId" IS NULL
    ELSE false
  END
);

CREATE OR REPLACE FUNCTION public.user_invitation_guard() RETURNS trigger AS $$
DECLARE
  v_role   text;
  v_tenant text;
  v_active boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'PENDING' THEN
      RAISE EXCEPTION 'An invitation is created PENDING (got %).', NEW."status";
    END IF;

    SELECT u."role"::text, u."tenantId", u."isActive" INTO v_role, v_tenant, v_active
      FROM public."users" u WHERE u."id" = NEW."invitedById";
    IF v_role IS NULL OR NOT v_active THEN
      RAISE EXCEPTION 'An invitation must come from an active user.';
    END IF;

    -- THE ROLE-ASSIGNMENT RULE. A SUPER_ADMIN may grant any role. An MSME_OWNER may grant
    -- a TENANT role in their OWN tenant. Nobody else may grant anything.
    IF v_role = 'SUPER_ADMIN' THEN
      RETURN NEW;
    END IF;
    IF v_role = 'MSME_OWNER'
       AND v_tenant IS NOT NULL
       AND NEW."tenantId" = v_tenant
       AND NEW."role"::text NOT IN ('SUPER_ADMIN', 'PROGRAM_OFFICER', 'MENTOR', 'COACH') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A % may not grant the role % (tenant %): only a SUPER_ADMIN grants platform roles, and an owner grants tenant roles in their own tenant only.',
      v_role, NEW."role", COALESCE(NEW."tenantId", 'none');
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."email" IS DISTINCT FROM OLD."email"
     OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."invitedById" IS DISTINCT FROM OLD."invitedById"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Invitation %: who was invited, to what, by whom and until when can never change.', OLD."id";
  END IF;

  IF OLD."status"::text <> 'PENDING' THEN
    RAISE EXCEPTION 'Invitation % is %, which is terminal.', OLD."id", OLD."status";
  END IF;
  IF NEW."status"::text NOT IN ('ACCEPTED', 'REVOKED', 'EXPIRED') THEN
    RAISE EXCEPTION 'Invitation % may not move PENDING -> %.', OLD."id", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_invitation_guard_iu
  BEFORE INSERT OR UPDATE ON public."user_invitations"
  FOR EACH ROW EXECUTE FUNCTION public.user_invitation_guard();
