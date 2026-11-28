-- ===========================================================================
-- 0035 — CASHIER LOCATION ASSIGNMENT (M4.5 Wave 3). HAND-WRITTEN.
--
-- A CASHIER sells from ONE assigned location — the till the owner or manager put them on — and
-- the backend, not the UI, holds it:
--
--   * `cashier_location_assignments`: one row per cashier (a platform user id), naming the
--     location they sell from. Reassigning is an UPDATE of that row; removing it is a DELETE.
--     Any ACTIVE location may be assigned (MAIN included — a one-till shop sells from it)
--     EXCEPT an ECOMMERCE one (a storefront is not a till).
--   * `shifts."locationId"` records WHERE a shift was opened, and `shifts."cashierAssigned"`
--     records that it was opened by a cashier UNDER an assignment. Both are written once, at
--     INSERT, and frozen after. NULL / false on every shift before 0035 — those shifts were not
--     bound to a location (NULL-means-not-recorded; nothing is backfilled).
--
-- THE GUARANTEES (the service refuses first, with a clean 403; these triggers hold it for every
-- writer, raw SQL included):
--   * a shift opened UNDER an assignment must be at the cashier's CURRENT assigned location;
--   * an ONLINE sale in such a shift must sell from the shift's location AND from the cashier's
--     CURRENT assignment — so a reassignment takes effect at once (a shift opened at the old till
--     can no longer ring a sale; the cashier closes it and opens one at the new till).
--   * OFFLINE_SYNCED sales are NOT restricted here: a capture is replayed from the DEVICE's
--     registered location, under the offline rules (Task OFF.1), whatever has happened since.
--   * Owner / manager shifts carry cashierAssigned = false and are not restricted (they manage).
-- ===========================================================================

CREATE TABLE "cashier_location_assignments" (
  "userId"      TEXT NOT NULL,
  "locationId"  TEXT NOT NULL,
  "assignedBy"  TEXT NOT NULL,
  "assignedAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cashier_location_assignments_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "cashier_location_assignments_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "cashier_location_assignments_locationId_idx" ON "cashier_location_assignments"("locationId");

-- An assignment names an ACTIVE location that is not a storefront.
CREATE OR REPLACE FUNCTION cashier_assignment_location_guard() RETURNS trigger AS $$
DECLARE
  loc RECORD;
BEGIN
  EXECUTE format('SELECT "isActive", "type"::text AS kind FROM %I.locations WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO loc USING NEW."locationId";
  IF loc IS NULL OR loc."isActive" IS NOT TRUE THEN
    RAISE EXCEPTION 'cashier_assignment_location_guard: location % is not an active location', NEW."locationId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF loc.kind = 'ECOMMERCE' THEN
    RAISE EXCEPTION 'cashier_assignment_location_guard: a cashier cannot be assigned to a storefront location'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cashier_assignment_location_guard
  BEFORE INSERT OR UPDATE OF "locationId" ON "cashier_location_assignments"
  FOR EACH ROW EXECUTE FUNCTION cashier_assignment_location_guard();

ALTER TABLE "shifts" ADD COLUMN "locationId" TEXT;
ALTER TABLE "shifts" ADD COLUMN "cashierAssigned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "shifts_locationId_idx" ON "shifts"("locationId");
-- A shift opened under an assignment always records its location.
ALTER TABLE "shifts" ADD CONSTRAINT "shift_assigned_has_location" CHECK (NOT "cashierAssigned" OR "locationId" IS NOT NULL);

CREATE OR REPLACE FUNCTION shift_location_guard() RETURNS trigger AS $$
DECLARE
  assigned TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."locationId" IS DISTINCT FROM OLD."locationId" OR NEW."cashierAssigned" IS DISTINCT FROM OLD."cashierAssigned" THEN
      RAISE EXCEPTION 'shift_location_guard: a shift''s location is fixed when it opens'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."cashierAssigned" THEN
    EXECUTE format('SELECT "locationId" FROM %I.cashier_location_assignments WHERE "userId" = $1', TG_TABLE_SCHEMA)
      INTO assigned USING NEW."cashierId";
    IF assigned IS NULL OR assigned IS DISTINCT FROM NEW."locationId" THEN
      RAISE EXCEPTION 'shift_location_guard: cashier % may open a shift only at their assigned location', NEW."cashierId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shift_location_guard
  BEFORE INSERT OR UPDATE ON "shifts"
  FOR EACH ROW EXECUTE FUNCTION shift_location_guard();

CREATE OR REPLACE FUNCTION sale_assigned_location_guard() RETURNS trigger AS $$
DECLARE
  sh RECORD;
  assigned TEXT;
  selling TEXT;
BEGIN
  IF NEW."origin"::text <> 'ONLINE' THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT "cashierId", "locationId", "cashierAssigned" FROM %I.shifts WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO sh USING NEW."shiftId";
  IF sh IS NULL OR sh."cashierAssigned" IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  -- NULL selling location means MAIN (the NULL-means-default rule).
  IF NEW."sellingLocationId" IS NULL THEN
    EXECUTE format('SELECT "id" FROM %I.locations WHERE "isDefault" = true', TG_TABLE_SCHEMA) INTO selling;
  ELSE
    selling := NEW."sellingLocationId";
  END IF;
  EXECUTE format('SELECT "locationId" FROM %I.cashier_location_assignments WHERE "userId" = $1', TG_TABLE_SCHEMA)
    INTO assigned USING sh."cashierId";
  IF selling IS DISTINCT FROM sh."locationId" OR assigned IS NULL OR assigned IS DISTINCT FROM selling THEN
    RAISE EXCEPTION 'sale_assigned_location_guard: this shift''s cashier may sell only from their assigned location'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sale_assigned_location_guard
  BEFORE INSERT ON "sales"
  FOR EACH ROW EXECUTE FUNCTION sale_assigned_location_guard();
