-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE_RECEIPT', 'SALE', 'SALE_RETURN', 'PURCHASE_RETURN', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE', 'WRITE_OFF', 'TRANSFER_IN', 'TRANSFER_OUT', 'OPENING_BALANCE');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "avgCost" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "stockValue" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "kraPin" TEXT,
    "paymentTerms" TEXT,
    "leadTimeDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "movementType" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "totalCost" BIGINT NOT NULL,
    "balanceQty" DECIMAL(14,3) NOT NULL,
    "balanceValue" BIGINT NOT NULL,
    "avgCostAfter" BIGINT NOT NULL,
    "supplierId" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "journalEntryId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_name_idx" ON "suppliers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_journalEntryId_key" ON "stock_movements"("journalEntryId");

-- CreateIndex
CREATE INDEX "stock_movements_productId_createdAt_idx" ON "stock_movements"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_movementType_idx" ON "stock_movements"("movementType");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. Prisma cannot express any of it. All
-- identifiers are unqualified and resolve against the tenant search_path at
-- runtime; the migration stays schema-neutral (it neither creates a schema nor
-- hard-codes a schema-qualified prefix).
-- ===========================================================================

-- (a) Stock and its valuation can never go negative. This is the last line of
-- defence behind the service's own check — the DB makes negative stock
-- unrepresentable.
ALTER TABLE "products" ADD CONSTRAINT product_stock_non_negative
  CHECK ("stockCount" >= 0 AND "stockValue" >= 0 AND "avgCost" >= 0);

-- (b) A movement's quantity sign must agree with its type. Inbound types carry a
-- positive quantity, outbound types a negative one; zero is always rejected.
-- The service derives the sign, but the DB enforces it independently.
CREATE OR REPLACE FUNCTION stock_movement_sign_check() RETURNS trigger AS $$
DECLARE
  v_type text := NEW."movementType"::text;
BEGIN
  IF NEW.quantity = 0 THEN
    RAISE EXCEPTION 'Stock movement quantity must be non-zero (product %).', NEW."productId";
  END IF;

  IF v_type IN ('PURCHASE_RECEIPT', 'SALE_RETURN', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN', 'OPENING_BALANCE') THEN
    IF NEW.quantity < 0 THEN
      RAISE EXCEPTION 'Movement type % requires a positive quantity, got %.', v_type, NEW.quantity;
    END IF;
  ELSIF v_type IN ('SALE', 'PURCHASE_RETURN', 'ADJUSTMENT_DECREASE', 'WRITE_OFF', 'TRANSFER_OUT') THEN
    IF NEW.quantity > 0 THEN
      RAISE EXCEPTION 'Movement type % requires a negative quantity, got %.', v_type, NEW.quantity;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown stock movement type %.', v_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movement_sign_check
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movement_sign_check();

-- (c) Movements are immutable. A stock history that can be edited is not a stock
-- history — corrections are made by recording a further, offsetting movement.
CREATE OR REPLACE FUNCTION stock_movement_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Stock movements are immutable and cannot be % once recorded.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movement_no_change
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movement_no_change();
