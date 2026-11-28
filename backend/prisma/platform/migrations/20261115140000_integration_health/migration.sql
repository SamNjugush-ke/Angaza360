-- ===========================================================================
-- M4.5 Wave 1 (T-B1) — the PLATFORM MIRROR of integration health, for the Command Center.
--
-- The authoritative health record lives on each business's own credential row (tenant
-- migration 0034). A platform operator must see, across businesses, which integrations
-- are failing — WITHOUT a cross-schema read. So every live verify also writes this
-- mirror, in the SAME transaction as the tenant row (the T-A13 mirroring pattern): one
-- row per (business, provider, environment), operational metadata only — status, when,
-- and the last error in words. It holds NO credential and NO business data.
-- Plain ids, like the audit log: the record outlives the business.
-- ===========================================================================

CREATE TABLE "integration_health" (
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastCheckAt" TIMESTAMPTZ(3) NOT NULL,
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_health_pkey" PRIMARY KEY ("tenantId", "provider", "environment")
);

CREATE INDEX "integration_health_status_idx" ON "integration_health"("status");

ALTER TABLE "integration_health" ADD CONSTRAINT "integration_health_coherent" CHECK (
  CASE "status"
    WHEN 'HEALTHY' THEN "lastError" IS NULL AND "lastVerifiedAt" IS NOT NULL
    WHEN 'FAILING' THEN "lastError" IS NOT NULL AND length("lastError") <= 300
    ELSE false
  END
);
