-- ===========================================================================
-- Task T-A6.1 — onboarding DEDUP guarantees (platform schema).
--
-- The onboarding green-gate refuses a duplicate business name, KRA PIN or owner
-- National ID in the SERVICE; these indexes are the guarantee behind it for every
-- writer, raw SQL included:
--   * a business name is unique CASE-INSENSITIVELY across tenants;
--   * a tenant's KRA PIN, when given, is unique;
--   * a user's National ID, when given, is unique.
-- The owner's National ID travels on the invitation (user_invitations."nationalId")
-- until the owner accepts and their user row exists.
--
-- PRECONDITION: these assume no existing duplicates — true in the test database. A
-- database holding duplicate names, PINs or IDs must resolve them BEFORE this deploys;
-- the migration then fails loudly rather than guessing which row to keep.
-- ===========================================================================

CREATE UNIQUE INDEX "tenants_name_lower_key" ON "tenants" (lower("name"));

CREATE UNIQUE INDEX "tenants_kraPin_key" ON "tenants" ("kraPin") WHERE "kraPin" IS NOT NULL;

ALTER TABLE "users" ADD COLUMN "nationalId" TEXT;

CREATE UNIQUE INDEX "users_nationalId_key" ON "users" ("nationalId") WHERE "nationalId" IS NOT NULL;

ALTER TABLE "user_invitations" ADD COLUMN "nationalId" TEXT;
