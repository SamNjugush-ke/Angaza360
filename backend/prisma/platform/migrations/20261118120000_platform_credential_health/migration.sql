-- ===========================================================================
-- PLATFORM NOTIFICATION CREDENTIALS, MANAGED (M4.5 Wave 5). HAND-WRITTEN.
--
-- Angaza's own SMTP / Africa's Talking / SendGrid credentials become manageable by a SUPER_ADMIN:
-- stored (a ROTATION returns the row to PENDING and UNVERIFIED), activated, deactivated, verified.
-- This adds the verification record beside the encrypted blob — mirroring the tenant store's
-- 0034 columns — plus who last stored the row, and pins the shapes:
--   * status is PENDING | ACTIVE | INACTIVE, and only these three;
--   * the health record is coherent (fail-closed: HEALTHY has a check time and no error, FAILING a
--     check time and an error, UNVERIFIED neither);
--   * provider and environment are the known ones.
-- No row exists anywhere yet (verified on angaza_dev); the CHECKs are therefore safe to add.
-- ===========================================================================

ALTER TABLE "platform_integration_credentials"
  ADD COLUMN "healthStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "lastHealthCheckAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastHealthError" TEXT,
  ADD COLUMN "lastVerifiedAt" TIMESTAMPTZ(3),
  ADD COLUMN "updatedById" TEXT;

ALTER TABLE "platform_integration_credentials"
  ADD CONSTRAINT "platform_credential_status_known" CHECK ("status" IN ('PENDING', 'ACTIVE', 'INACTIVE')),
  ADD CONSTRAINT "platform_credential_environment_known" CHECK ("environment" IN ('sandbox', 'production')),
  ADD CONSTRAINT "platform_credential_health_coherent" CHECK (
    CASE "healthStatus"
      WHEN 'UNVERIFIED' THEN "lastHealthCheckAt" IS NULL AND "lastHealthError" IS NULL
      WHEN 'HEALTHY' THEN "lastHealthCheckAt" IS NOT NULL AND "lastHealthError" IS NULL AND "lastVerifiedAt" IS NOT NULL
      WHEN 'FAILING' THEN "lastHealthCheckAt" IS NOT NULL AND "lastHealthError" IS NOT NULL AND length(btrim("lastHealthError")) > 0
      ELSE false
    END
  );
