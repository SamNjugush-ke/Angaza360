-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "sellingLocationId" TEXT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_sellingLocationId_fkey" FOREIGN KEY ("sellingLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- NO BACKFILL, DELIBERATELY — NULL MEANS MAIN.
--
-- Every sale recorded before this column existed genuinely drew its stock from
-- MAIN: the sale path passed no location and the inventory service defaulted to
-- the tenant's default location. So NULL already states the truth about those
-- rows, and their voids keep returning stock to MAIN, which is exactly where it
-- came from. Writing a value into historical sales would restate settled
-- financial records to say something they already say.
--
-- This is the same NULL-means-default pattern as locationId on stock_movements
-- (0007) and lineCogs on sale_lines (0012). Reads that need the effective
-- location COALESCE NULL to the default location.
-- ===========================================================================

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- (a) THE SELLING LOCATION IS IMMUTABLE, like every other identity field on a
-- sale.
--
-- This replaces sale_guard_update() (last replaced in 0009, which added the
-- paymentStatus settlement transition) to ALSO freeze "sellingLocationId". It is
-- a STRENGTHENING, not a weakening: without it the new column would be the only
-- field on the table a caller could rewrite after the fact, and rewriting it
-- would send a later void's stock to a location the sale never drew from —
-- silently moving inventory between locations while every aggregate still
-- balanced. Everything else about the guard is carried over unchanged: the
-- financial/identity fields stay immutable, the void transition is still the
-- only permitted status change, and paymentStatus is still free to settle.
CREATE OR REPLACE FUNCTION sale_guard_update() RETURNS trigger AS $$
BEGIN
  -- Financial / identity fields are immutable, always.
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
     -- Task 3.2-LOC: where the stock came from is part of the sale's identity.
     OR NEW."sellingLocationId" IS DISTINCT FROM OLD."sellingLocationId"
  THEN
    RAISE EXCEPTION 'Sale % is immutable; only voiding and payment-settlement status may change.',
      OLD."saleNumber";
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- A status change is permitted ONLY as the void transition.
    IF NOT (OLD.status::text = 'COMPLETED' AND NEW.status::text = 'VOIDED') THEN
      RAISE EXCEPTION 'Sale % status may only transition COMPLETED -> VOIDED.', OLD."saleNumber";
    END IF;
    IF OLD."voidedByEntryId" IS NOT NULL THEN
      RAISE EXCEPTION 'Sale % is already voided.', OLD."saleNumber";
    END IF;
    IF NEW."voidedByEntryId" IS NULL THEN
      RAISE EXCEPTION 'Sale % void must set voidedByEntryId.', OLD."saleNumber";
    END IF;
  ELSE
    -- status unchanged: the void marker fields must not change here.
    IF NEW."voidedByEntryId" IS DISTINCT FROM OLD."voidedByEntryId"
       OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"
    THEN
      RAISE EXCEPTION 'Sale % void fields may only change during the COMPLETED -> VOIDED transition.',
        OLD."saleNumber";
    END IF;
  END IF;

  -- paymentStatus is free to change (settlement lifecycle).
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (b) DELIBERATELY NO CHECK tying sellingLocationId to a location TYPE.
-- Which location types may sell is a BUSINESS rule that changes as channels are
-- added (a POS till today; an e-commerce location when the storefront lands; a
-- branch counter after that). Encoding today's answer as a CHECK would force a
-- migration the day a new channel starts selling, against live financial rows.
-- The service validates the location exists and is active — the part that is
-- structural — and the FK guarantees it refers to a real location in THIS
-- tenant's schema, which is the integrity the database is the right place to
-- enforce.
