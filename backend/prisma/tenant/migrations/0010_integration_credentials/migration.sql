-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('MPESA', 'ETIMS', 'STRIPE', 'SMS');

-- CreateEnum
CREATE TYPE "IntegrationEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED', 'DISABLED');

-- CreateTable
CREATE TABLE "tenant_integration_credentials" (
    "id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "environment" "IntegrationEnvironment" NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "keyRef" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "label" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_settings" (
    "id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "activeEnvironment" "IntegrationEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_integration_credentials_provider_status_idx" ON "tenant_integration_credentials"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_integration_credentials_provider_environment_key" ON "tenant_integration_credentials"("provider", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "integration_settings_provider_key" ON "integration_settings"("provider");

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- (a) At most ONE ACTIVE credential per (provider, environment). The @@unique
-- above already guarantees one ROW per provider+environment, so today this is
-- belt and suspenders. Both are kept deliberately: if the @@unique is ever
-- relaxed to retain rotation history (several rows per provider+environment),
-- this partial index is what still guarantees the factory can never find two
-- ACTIVE credentials and pick one arbitrarily.
CREATE UNIQUE INDEX one_active_credential_per_provider_env
  ON "tenant_integration_credentials" ("provider", "environment")
  WHERE status = 'ACTIVE';

-- (b) A credential row's IDENTITY is (provider, environment) — that pair is what
-- the provider factory resolves by. Rotating a credential replaces the encrypted
-- blob; it never re-points an existing row at a different provider or a
-- different environment (which would silently make a sandbox row serve
-- production traffic, or an M-Pesa row answer for eTIMS). The blob parts,
-- status, label and lastVerifiedAt are all freely updatable — that is what
-- rotation, activation and verification do. createdBy/createdAt record who first
-- stored the credential and are not rewritten by a later rotation.
CREATE OR REPLACE FUNCTION tenant_integration_credential_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.environment IS DISTINCT FROM OLD.environment
  THEN
    RAISE EXCEPTION 'Integration credential % identity (provider/environment) is immutable: rotate the encrypted blob, never re-point the row (% / % -> % / %).',
      OLD.id, OLD.provider, OLD.environment, NEW.provider, NEW.environment;
  END IF;

  IF NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Integration credential % createdBy/createdAt are immutable.', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_integration_credential_identity_immutable
  BEFORE UPDATE ON tenant_integration_credentials
  FOR EACH ROW EXECUTE FUNCTION tenant_integration_credential_guard_update();

-- (c) The same identity rule for the per-provider setting row: a settings row is
-- keyed by its provider and never re-pointed at another one. activeEnvironment
-- and enabled are exactly the two fields that are MEANT to change — flipping
-- activeEnvironment SANDBOX -> PRODUCTION is the "Go Live" action.
CREATE OR REPLACE FUNCTION integration_setting_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'Integration setting % provider is immutable (% -> %).',
      OLD.id, OLD.provider, NEW.provider;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER integration_setting_provider_immutable
  BEFORE UPDATE ON integration_settings
  FOR EACH ROW EXECUTE FUNCTION integration_setting_guard_update();
