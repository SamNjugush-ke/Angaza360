-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "TenderType" AS ENUM ('CASH', 'MPESA', 'BANK_TRANSFER', 'CREDIT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "openingFloat" BIGINT NOT NULL,
    "closingFloat" BIGINT,
    "expectedCash" BIGINT,
    "variance" BIGINT,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" TEXT NOT NULL,
    "saleNumber" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "subtotal" BIGINT NOT NULL,
    "vatTotal" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,
    "cogsTotal" BIGINT NOT NULL,
    "saleJournalEntryId" TEXT,
    "voidedByEntryId" TEXT,
    "voidReason" TEXT,
    "reference" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_lines" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "lineNet" BIGINT NOT NULL,
    "lineVat" BIGINT NOT NULL,
    "lineTotal" BIGINT NOT NULL,
    "unitCogs" BIGINT NOT NULL,

    CONSTRAINT "sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_tenders" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "tenderType" "TenderType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "mpesaReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_tenders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "kraPin" TEXT,
    "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
    "creditLimit" BIGINT NOT NULL DEFAULT 0,
    "creditBalance" BIGINT NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shifts_cashierId_status_idx" ON "shifts"("cashierId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_saleNumber_key" ON "sales"("saleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "sales_saleJournalEntryId_key" ON "sales"("saleJournalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_voidedByEntryId_key" ON "sales"("voidedByEntryId");

-- CreateIndex
CREATE INDEX "sales_createdAt_idx" ON "sales"("createdAt");

-- CreateIndex
CREATE INDEX "sales_shiftId_idx" ON "sales"("shiftId");

-- CreateIndex
CREATE INDEX "sale_lines_productId_idx" ON "sale_lines"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_lines_saleId_lineNumber_key" ON "sale_lines"("saleId", "lineNumber");

-- CreateIndex
CREATE INDEX "sale_tenders_saleId_idx" ON "sale_tenders"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_name_idx" ON "customers"("name");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- Per-tenant DAILY sale-number counter. One row per calendar day; the upsert in
-- the sale service atomically returns the next counter, so SALE-YYYYMMDD-000001
-- restarts each day and concurrent sales never collide.
CREATE TABLE "sale_number_counters" (
  "day"     DATE PRIMARY KEY,
  "counter" INTEGER NOT NULL
);

-- (a) Sale monetary coherence.
ALTER TABLE "sales" ADD CONSTRAINT sale_amounts_coherent
  CHECK (
    subtotal >= 0 AND "vatTotal" >= 0 AND "cogsTotal" >= 0
    AND total = subtotal + "vatTotal"
  );

-- (b) Sale line coherence.
ALTER TABLE "sale_lines" ADD CONSTRAINT sale_line_amounts_coherent
  CHECK (
    quantity > 0 AND "unitPrice" >= 0 AND discount >= 0 AND "lineNet" >= 0
    AND "lineTotal" = "lineNet" + "lineVat"
  );

-- (e) Customer credit coherence.
ALTER TABLE "customers" ADD CONSTRAINT customer_credit_coherent
  CHECK ("creditBalance" >= 0 AND "creditLimit" >= 0);

-- (c) Sale lines and tenders are write-once. A void is a new reversing posting
-- plus a status change on the sale, never an edit of the originals.
CREATE OR REPLACE FUNCTION sale_child_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Sale % rows are write-once and cannot be % once recorded.', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sale_line_no_change
  BEFORE UPDATE OR DELETE ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION sale_child_no_change();

CREATE TRIGGER sale_tender_no_change
  BEFORE UPDATE OR DELETE ON sale_tenders
  FOR EACH ROW EXECUTE FUNCTION sale_child_no_change();

-- (d) A sale is immutable except for the void transition: status COMPLETED ->
-- VOIDED together with voidedByEntryId NULL -> value (and its reason). Every
-- other change is rejected. Mirrors the journal-entry immutability guard.
CREATE OR REPLACE FUNCTION sale_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id                 IS DISTINCT FROM OLD.id
     OR NEW."saleNumber"    IS DISTINCT FROM OLD."saleNumber"
     OR NEW."shiftId"       IS DISTINCT FROM OLD."shiftId"
     OR NEW."customerId"    IS DISTINCT FROM OLD."customerId"
     OR NEW.subtotal        IS DISTINCT FROM OLD.subtotal
     OR NEW."vatTotal"      IS DISTINCT FROM OLD."vatTotal"
     OR NEW.total           IS DISTINCT FROM OLD.total
     OR NEW."cogsTotal"     IS DISTINCT FROM OLD."cogsTotal"
     OR NEW."saleJournalEntryId" IS DISTINCT FROM OLD."saleJournalEntryId"
     OR NEW.reference       IS DISTINCT FROM OLD.reference
     OR NEW."createdBy"     IS DISTINCT FROM OLD."createdBy"
     OR NEW."createdAt"     IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Sale % is immutable; only voiding is permitted.', OLD."saleNumber";
  END IF;

  IF OLD."voidedByEntryId" IS NOT NULL THEN
    RAISE EXCEPTION 'Sale % is already voided.', OLD."saleNumber";
  END IF;
  IF NEW."voidedByEntryId" IS NULL THEN
    RAISE EXCEPTION 'Sale % update did not set voidedByEntryId.', OLD."saleNumber";
  END IF;
  IF NOT (OLD.status::text = 'COMPLETED' AND NEW.status::text = 'VOIDED') THEN
    RAISE EXCEPTION 'Sale % void must transition status COMPLETED -> VOIDED.', OLD."saleNumber";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sale_no_update
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION sale_guard_update();
