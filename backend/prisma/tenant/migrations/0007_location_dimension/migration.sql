-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_code_key" ON "locations"("code");

-- CreateIndex
CREATE INDEX "stock_movements_locationId_idx" ON "stock_movements"("locationId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- (a) Exactly one default location. A partial unique index makes a second
-- isDefault = true row unrepresentable.
CREATE UNIQUE INDEX one_default_location
  ON "locations" ("isDefault") WHERE "isDefault" = true;

-- (b) A location that still has stock movements against it cannot be deleted.
-- The cross-table lookup qualifies stock_movements via TG_TABLE_SCHEMA so it
-- resolves regardless of the connection search_path. (The FK is ON DELETE SET
-- NULL as Prisma generated it; this trigger fires first and refuses the delete,
-- so history is never orphaned.)
CREATE OR REPLACE FUNCTION location_protect_delete() RETURNS trigger AS $$
DECLARE
  v_schema text := TG_TABLE_SCHEMA;
  v_refs   bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I.stock_movements WHERE "locationId" = $1', v_schema)
    INTO v_refs USING OLD.id;
  IF v_refs > 0 THEN
    RAISE EXCEPTION 'Location % (%) has % stock movement(s) and cannot be deleted.',
      OLD.code, OLD.name, v_refs;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER location_no_delete_with_movements
  BEFORE DELETE ON locations
  FOR EACH ROW EXECUTE FUNCTION location_protect_delete();
