-- CreateTable
CREATE TABLE "product_location_stock" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_location_stock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_location_stock_locationId_idx" ON "product_location_stock"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "product_location_stock_productId_locationId_key" ON "product_location_stock"("productId", "locationId");

-- AddForeignKey
ALTER TABLE "product_location_stock" ADD CONSTRAINT "product_location_stock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_location_stock" ADD CONSTRAINT "product_location_stock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- (a) A location can NEVER own negative stock. This is the structural form of
-- "nothing sells stock it does not own": the service checks the source
-- location's owned quantity before every outbound movement and every transfer,
-- and this CHECK is the last line of defence behind that check — it makes an
-- overselling location unrepresentable rather than merely rejected.
ALTER TABLE "product_location_stock" ADD CONSTRAINT product_location_stock_non_negative
  CHECK ("quantity" >= 0);

-- (b) DELIBERATELY NO cross-row aggregate trigger for the invariant
--     Product.stockCount = SUM(product_location_stock.quantity).
-- Enforcing it in the database would require re-aggregating every location row
-- for a product on every single movement — an O(locations) read plus a write
-- amplification on the hottest path in the system (every sale line). The
-- inventory service is the SOLE writer of both sides and maintains them inside
-- one transaction, so the two can only diverge via a bug in one module, not via
-- a second writer. What the DB enforces here is what it can enforce cheaply and
-- locally — the non-negative CHECK above and the (productId, locationId) unique
-- index. The aggregate invariant is verified by acceptance criteria instead.
-- This is a considered exception to "prefer the DB constraint", recorded so a
-- later reader does not mistake it for an oversight.

-- (c) DELIBERATELY NO immutability trigger on this table.
-- product_location_stock is the CURRENT-BALANCE PROJECTION: its quantity is
-- MEANT to change every time stock moves in, out, or between locations. The
-- immutable audit trail is stock_movements, which already records every one of
-- those changes and already refuses UPDATE and DELETE (migration 0005). History
-- lives in the movements; the balance lives here. Adding an immutability
-- trigger here would make the table unusable; omitting one on stock_movements
-- would lose the history. Both statements are part of the same design.
