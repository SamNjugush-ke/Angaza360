-- ===========================================================================
-- 0027 — PRODUCT KIND: GOOD or SERVICE (Task T-A8). HAND-WRITTEN.
--
-- A GOOD is stock: received, held, valued and depleted through the inventory service,
-- exactly as before. A SERVICE carries NO stock: a sale line for it posts revenue, output
-- VAT and the TOT subtotal and NOTHING on the cost side — no stock movement, no COGS, no
-- touch of account 1200. So Σ Product.stockValue = GL(1200) holds with every service
-- contributing exactly zero.
--
-- EXISTING ROWS: every product created before this migration was stock, so the column
-- defaults to GOOD and the existing behaviour is preserved byte for byte. No row is
-- rewritten beyond taking the default.
-- ===========================================================================

CREATE TYPE "ProductType" AS ENUM ('GOOD', 'SERVICE');

ALTER TABLE "products" ADD COLUMN "kind" "ProductType" NOT NULL DEFAULT 'GOOD';

-- A SERVICE PRODUCT CARRIES NO STOCK. The inventory service refuses every movement for a
-- service; this CHECK is the guarantee behind it for any writer, raw SQL included.
-- (A type CREATED in this transaction is usable at once — the ADD VALUE restriction in
-- the engineering ledger "Working Practices" does not apply to a new type.)
ALTER TABLE "products" ADD CONSTRAINT "product_service_carries_no_stock" CHECK (
  "kind" <> 'SERVICE'
  OR ("stockCount" = 0 AND "stockValue" = 0 AND "avgCost" = 0 AND "batchTracked" = false)
);

-- KIND IS FROZEN ONCE CREATED. A void decides from the product's kind whether a sale
-- line has stock to return (a SERVICE line has none). Flipping a sold GOOD to SERVICE
-- would make its void skip the SALE_RETURN and leave the stock it sold permanently out
-- of 1200; flipping a SERVICE to GOOD would make a void try to return stock that never
-- left. A product that was mis-classified is retired and a new one created.
CREATE OR REPLACE FUNCTION product_kind_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'Product %: its kind (%) is fixed once created. Create a new product instead.', OLD."sku", OLD."kind";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_kind_guard_u
  BEFORE UPDATE OF "kind" ON "products"
  FOR EACH ROW EXECUTE FUNCTION product_kind_guard();
