-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "CapturedSaleStatus" AS ENUM ('POSTED', 'REPLAYED', 'NEEDS_RESOLUTION');

-- CreateEnum
CREATE TYPE "FreezeStatus" AS ENUM ('PENDING_RECONCILIATION', 'RELEASED_BY_SYNC', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "SaleOrigin" AS ENUM ('ONLINE', 'OFFLINE_SYNCED');

-- AlterTable
ALTER TABLE "product_location_stock" ADD COLUMN     "frozenQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "businessTimestamp" TIMESTAMP(3),
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "origin" "SaleOrigin" NOT NULL DEFAULT 'ONLINE',
ADD COLUMN     "originalBusinessDate" TIMESTAMP(3),
ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "pos_devices" (
    "id" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "leaseStartedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "registeredBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "captured_sales" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "businessTimestamp" TIMESTAMP(3) NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "CapturedSaleStatus" NOT NULL,
    "reason" TEXT,
    "saleId" TEXT,
    "syncedBy" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "captured_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_freezes" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "FreezeStatus" NOT NULL DEFAULT 'PENDING_RECONCILIATION',
    "leaseExpiredAt" TIMESTAMP(3) NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "productCount" INTEGER NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "stock_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_devices_locationId_status_idx" ON "pos_devices"("locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "captured_sales_idempotencyKey_key" ON "captured_sales"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "captured_sales_saleId_key" ON "captured_sales"("saleId");

-- CreateIndex
CREATE INDEX "captured_sales_status_idx" ON "captured_sales"("status");

-- CreateIndex
CREATE INDEX "captured_sales_deviceId_status_idx" ON "captured_sales"("deviceId", "status");

-- CreateIndex
CREATE INDEX "stock_freezes_status_idx" ON "stock_freezes"("status");

-- CreateIndex
CREATE INDEX "stock_freezes_deviceId_status_idx" ON "stock_freezes"("deviceId", "status");

-- CreateIndex
CREATE INDEX "sales_origin_businessTimestamp_idx" ON "sales"("origin", "businessTimestamp");

-- AddForeignKey
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captured_sales" ADD CONSTRAINT "captured_sales_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "pos_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captured_sales" ADD CONSTRAINT "captured_sales_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_freezes" ADD CONSTRAINT "stock_freezes_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "pos_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_freezes" ADD CONSTRAINT "stock_freezes_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "pos_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- NO BACKFILL, DELIBERATELY.
--
-- Every sale that exists today was rung ONLINE, at the server, in real time:
-- there was no device, no capture and no sync before this migration. So
-- origin DEFAULT 'ONLINE' and NULL in businessTimestamp / syncedAt / deviceId /
-- idempotencyKey / originalBusinessDate already state the truth about those
-- rows, and writing values into them would restate settled financial records to
-- say something they already say. Same NULL-means-default pattern as locationId
-- on stock_movements (0007), lineCogs on sale_lines (0012) and
-- sellingLocationId on sales (0014).
--
-- product_location_stock."frozenQuantity" DEFAULT 0 is likewise already true:
-- nothing has ever been frozen, because nothing could be.
-- ===========================================================================

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- (a) IDEMPOTENCY IS A DATABASE GUARANTEE, not a service convention.
--
-- A PARTIAL unique index, so the many ONLINE sales that carry no key never
-- collide with each other. (Postgres already treats NULLs as distinct in a
-- plain unique index; the predicate states the intent explicitly and keeps the
-- index out of the way of every online sale.) The name is the one the
-- datamodel's `@unique` implies, so client and database agree.
--
-- This index — not the service's lookup — is what makes at-least-once delivery
-- safe. A device may retry a batch as often as a bad connection demands: a
-- second INSERT of the same captured sale cannot physically exist, so there can
-- be no second journal entry and no second stock decrement.
CREATE UNIQUE INDEX "sales_idempotencyKey_key"
  ON "sales" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- (b) THE TWO SHAPES OF A SALE'S PROVENANCE.
--
-- An ONLINE sale carries NO offline dimension at all; an OFFLINE_SYNCED sale
-- carries ALL FOUR. A half-filled provenance — a synced sale with no device, an
-- online sale with an idempotency key — would make "where did this sale come
-- from?" unanswerable, so it is made unrepresentable instead of merely avoided.
-- This is stricter than the minimum: the task required only that ONLINE carry no
-- idempotencyKey, but there is no honest reading of an online sale that has a
-- businessTimestamp or a capturing device.
--
-- originalBusinessDate belongs exclusively to the closed-period fallback, which
-- only an offline replay can take.
ALTER TABLE "sales" ADD CONSTRAINT sale_offline_dimensions_complete
  CHECK (
    ("origin" = 'ONLINE'
       AND "idempotencyKey"       IS NULL
       AND "businessTimestamp"    IS NULL
       AND "syncedAt"             IS NULL
       AND "deviceId"             IS NULL
       AND "originalBusinessDate" IS NULL)
    OR
    ("origin" = 'OFFLINE_SYNCED'
       AND "idempotencyKey"    IS NOT NULL
       AND "businessTimestamp" IS NOT NULL
       AND "syncedAt"          IS NOT NULL
       AND "deviceId"          IS NOT NULL)
  );

-- (c) THE OFFLINE COLUMNS ARE IMMUTABLE, like every other identity field on a
-- sale, and NO new transition is permitted.
--
-- This replaces sale_guard_update() (last replaced in 0014, which added
-- sellingLocationId) to ALSO freeze "origin", "businessTimestamp", "syncedAt",
-- "deviceId", "idempotencyKey" and "originalBusinessDate". Everything else is
-- carried over unchanged: the financial/identity fields stay immutable, the
-- COMPLETED -> VOIDED transition is still the only permitted status change, and
-- paymentStatus is still free to settle.
--
-- WHICH TRANSITION IS PERMITTED ON THE NEW COLUMNS: none, and that is not an
-- oversight. All six are written by the sync service in the SAME transaction
-- that CREATES the sale (src/services/offline/sync.ts calls sales.ts's
-- transaction-participating entry point), so there is no arrival-then-update
-- step for the resolution flow to need. Rewriting any of them afterwards would
-- let a posted sale change which period it belongs to, which device captured it,
-- or whether its key had already been consumed — the three facts idempotency and
-- business-time integrity rest on.
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
     -- Task OFF.1: so is where the sale came from, when it happened, which
     -- device captured it, and which key was consumed for it.
     OR NEW."origin"               IS DISTINCT FROM OLD."origin"
     OR NEW."businessTimestamp"    IS DISTINCT FROM OLD."businessTimestamp"
     OR NEW."syncedAt"             IS DISTINCT FROM OLD."syncedAt"
     OR NEW."deviceId"             IS DISTINCT FROM OLD."deviceId"
     OR NEW."idempotencyKey"       IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."originalBusinessDate" IS DISTINCT FROM OLD."originalBusinessDate"
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

-- (d) A DEVICE ONLY EXISTS WHERE OFFLINE SELLING MEANS SOMETHING.
--
-- A device may bind ONLY to an offline-capable location. MAIN is the
-- server-held authoritative pool and an ECOMMERCE channel is server-side by
-- definition (migration 0013 already forbids either from being
-- offline-capable), so neither can be a device that goes dark holding stock.
-- The service refuses this with a readable message; THIS TRIGGER is the
-- guarantee — without it a direct INSERT could attach a lease clock, and
-- therefore a freeze, to the tenant's own stock pool.
--
-- The lookup is schema-safe via TG_TABLE_SCHEMA rather than a bare table name:
-- the pg adapter does not set search_path, so an unqualified cross-table
-- reference in a trigger body would resolve against public (the engineering ledger, "Raw SQL
-- and Tenant Schema Resolution").
CREATE OR REPLACE FUNCTION pos_device_location_guard() RETURNS trigger AS $$
DECLARE
  loc_code    text;
  loc_type    text;
  loc_offline boolean;
BEGIN
  EXECUTE format(
    'SELECT "code", "type"::text, "isOfflineCapable" FROM %I.%I WHERE "id" = $1',
    TG_TABLE_SCHEMA, 'locations'
  ) INTO loc_code, loc_type, loc_offline USING NEW."locationId";

  IF loc_code IS NULL THEN
    RAISE EXCEPTION 'Device % references location %, which does not exist.',
      NEW."deviceName", NEW."locationId";
  END IF;

  IF loc_offline IS NOT TRUE THEN
    RAISE EXCEPTION
      'Location % (%) is not offline-capable, so no device may take custody of its stock.',
      loc_code, loc_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pos_device_location_must_be_offline_capable
  BEFORE INSERT OR UPDATE OF "locationId" ON pos_devices
  FOR EACH ROW EXECUTE FUNCTION pos_device_location_guard();

-- (e) THE LEASE CLOCK IS COHERENT OR ABSENT.
--
-- An expiry without a start is a clock with no beginning; an expiry at or before
-- its start is a lease that was already over when it was granted, which is not a
-- policy. NULL expiry WITH a start is the legitimate FOREVER lease that
-- the engineering ledger requires never to freeze (a permanent branch warehouse).
ALTER TABLE "pos_devices" ADD CONSTRAINT pos_device_lease_clock_coherent
  CHECK (
    ("leaseExpiresAt" IS NULL OR "leaseStartedAt" IS NOT NULL)
    AND
    ("leaseExpiresAt" IS NULL OR "leaseStartedAt" IS NULL OR "leaseExpiresAt" > "leaseStartedAt")
  );

-- (f) A CAPTURED SALE EITHER POSTED OR IS QUEUED. There is no third outcome and
-- no silent discard — that is the whole point of the table.
--
-- POSTED            carries the Sale it became and no reason.
-- NEEDS_RESOLUTION  carries a reason and NO sale, because nothing was posted:
--                   no journal entry, no stock movement, nothing negative.
--
-- REPLAYED IS NOT STORABLE, and the CHECK is how that is guaranteed rather than
-- merely intended. REPLAYED is the OUTCOME an ingest call reports when the key
-- is already POSTED here; it is a property of a call, never a state of a row. A
-- stored REPLAYED row would be a capture that claims to have been replayed while
-- pointing at no sale at all.
ALTER TABLE "captured_sales" ADD CONSTRAINT captured_sale_outcome_consistent
  CHECK (
    ("status" = 'POSTED'           AND "saleId" IS NOT NULL AND "reason" IS NULL)
    OR
    ("status" = 'NEEDS_RESOLUTION' AND "saleId" IS NULL     AND "reason" IS NOT NULL)
  );

-- (g) ONE ACTIVE FREEZE PER LOCATION.
--
-- Stock is location-owned, and frozenQuantity lives on the location's slices, so
-- two simultaneous PENDING_RECONCILIATION freezes over the same location would
-- make "which freeze immobilised this stock, and which resolution releases it?"
-- ambiguous. Two devices may share a location; the SECOND one to expire finds
-- the freeze already open and adds nothing, which is exactly right — the stock
-- is already immobilised.
CREATE UNIQUE INDEX one_active_freeze_per_location
  ON "stock_freezes" ("locationId") WHERE "status" = 'PENDING_RECONCILIATION';

-- (h) A FREEZE'S RESOLUTION STATE IS COHERENT, and it records WHO decided.
--
-- PENDING_RECONCILIATION  unresolved: no resolution timestamp, nobody decided.
-- RELEASED_BY_SYNC        resolved automatically when the truth arrived. NO
--                         resolvedBy, deliberately: nobody made a decision —
--                         the device simply reported what it had sold.
-- WRITTEN_OFF             resolved by an ADMIN, so resolvedBy is mandatory. A
--                         write-off posts Dr 5300 / Cr 1200 and is the only path
--                         by which frozen stock becomes a general-ledger event;
--                         an accounting loss must always name the person who
--                         decided to take it.
ALTER TABLE "stock_freezes" ADD CONSTRAINT stock_freeze_resolution_consistent
  CHECK (
    ("status" = 'PENDING_RECONCILIATION'
       AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL)
    OR
    ("status" = 'RELEASED_BY_SYNC'
       AND "resolvedAt" IS NOT NULL AND "resolvedBy" IS NULL)
    OR
    ("status" = 'WRITTEN_OFF'
       AND "resolvedAt" IS NOT NULL AND "resolvedBy" IS NOT NULL)
  );

-- (i) A freeze immobilises at least one product slice. Freezing nothing is not a
-- freeze; expireLeases records no row in that case.
ALTER TABLE "stock_freezes" ADD CONSTRAINT stock_freeze_product_count_positive
  CHECK ("productCount" > 0);

-- (j) FROZEN QUANTITY IS A PORTION OF WHAT THE LOCATION OWNS.
--
--     0 <= frozenQuantity <= quantity,  and  SELLABLE = quantity - frozenQuantity
--
-- The upper bound is the structural form of "frozen stock is still owned": a
-- freeze never changes `quantity`, so the invariant
-- Product.stockCount == SUM(product_location_stock.quantity) is untouched by
-- freezing, and sum(Product.stockValue) = GL(1200) keeps holding — which is why
-- a freeze posts no journal entry. The lower bound makes a "negative freeze"
-- (quietly handing sellable stock back) unrepresentable.
--
-- The inventory service checks SELLABLE before every outbound movement and
-- before every transfer out, and these CHECKs are the last line of defence
-- behind those checks, exactly as product_location_stock_non_negative is behind
-- the ownership check from 0011.
ALTER TABLE "product_location_stock" ADD CONSTRAINT product_location_stock_frozen_non_negative
  CHECK ("frozenQuantity" >= 0);

ALTER TABLE "product_location_stock" ADD CONSTRAINT product_location_stock_frozen_within_owned
  CHECK ("frozenQuantity" <= "quantity");

-- (k) DELIBERATELY NO CHECK tying a device's lease window to its location's
-- leaseWindowMinutes. The window is the LOCATION's admin-set policy and may be
-- edited at any time (Task 10.2 explicitly permits that); a device's
-- leaseExpiresAt is a snapshot of the policy AT THE MOMENT CUSTODY WAS TAKEN. A
-- constraint equating the two would retroactively invalidate every live lease
-- the instant an admin changed the policy — which is the opposite of what a
-- lease is for.
