-- ===========================================================================
-- Task T-A6.2 — tenant applications (platform schema).
--
-- A request to onboard a business that is not a tenant yet — a public self-serve
-- signup, or (T-A6.3) a row of an admin batch upload. Nothing is provisioned from a row
-- until it is approved (self-serve) or its batch committed (batch), and only if the
-- green-gate passes AGAIN at that moment. reviewedById / resultingTenantId are plain ids
-- (no foreign key): the decision outlives the reviewer and the tenant, like audit_logs.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "TenantApplicationStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TenantApplicationSource" AS ENUM ('SELF_SERVE', 'ADMIN', 'BATCH');

-- CreateTable
CREATE TABLE "tenant_applications" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "proposedSubdomain" TEXT,
    "sector" TEXT,
    "kraPin" TEXT,
    "taxRegime" TEXT NOT NULL,
    "requestedTier" TEXT,
    "ownerFullName" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "ownerPhone" TEXT,
    "ownerNationalId" TEXT,
    "status" "TenantApplicationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "source" "TenantApplicationSource" NOT NULL,
    "batchId" TEXT,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "resultingTenantId" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_applications_status_submittedAt_idx" ON "tenant_applications"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "tenant_applications_batchId_idx" ON "tenant_applications"("batchId");
