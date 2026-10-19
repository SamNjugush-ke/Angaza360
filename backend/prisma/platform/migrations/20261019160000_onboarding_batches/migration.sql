-- ===========================================================================
-- Task T-A6.3 — batch CSV onboarding (platform schema).
--
-- One upload = one onboarding_batches row; its data rows are tenant_applications rows
-- (source BATCH, batchId, batchRowNumber = the CSV data-line number). PREVIEW while rows
-- are corrected or removed; COMMITTED once every remaining row was GREEN and has been
-- provisioned. uploadedById is a plain id (no FK), like the audit log.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "OnboardingBatchStatus" AS ENUM ('PREVIEW', 'COMMITTED');

-- CreateTable
CREATE TABLE "onboarding_batches" (
    "id" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "status" "OnboardingBatchStatus" NOT NULL DEFAULT 'PREVIEW',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMPTZ(3),

    CONSTRAINT "onboarding_batches_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "tenant_applications" ADD COLUMN     "batchRowNumber" INTEGER;

-- AddForeignKey
ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_applications_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "onboarding_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A batch row carries its line number; any other application carries none.
ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_application_batch_row_coherent" CHECK (
  ("source"::text = 'BATCH') = ("batchId" IS NOT NULL)
  AND ("batchId" IS NOT NULL) = ("batchRowNumber" IS NOT NULL)
);
