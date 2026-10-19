-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('MAIN', 'POS', 'ECOMMERCE', 'BRANCH', 'ATTENDANT');

-- CreateEnum
CREATE TYPE "AllocationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED');

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "type" "LocationType" NOT NULL DEFAULT 'POS',
ADD COLUMN     "isOfflineCapable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leaseWindowMinutes" INTEGER,
ADD COLUMN     "sessionStart" TEXT,
ADD COLUMN     "sessionEnd" TEXT;

-- CreateTable
CREATE TABLE "allocation_requests" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "requestedQty" DECIMAL(14,3) NOT NULL,
    "approvedQty" DECIMAL(14,3),
    "status" "AllocationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "transferId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allocation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "locations_type_idx" ON "locations"("type");

-- CreateIndex
CREATE INDEX "allocation_requests_status_idx" ON "allocation_requests"("status");

-- CreateIndex
CREATE INDEX "allocation_requests_locationId_status_idx" ON "allocation_requests"("locationId", "status");

-- AddForeignKey
ALTER TABLE "allocation_requests" ADD CONSTRAINT "allocation_requests_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_requests" ADD CONSTRAINT "allocation_requests_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_requests" ADD CONSTRAINT "allocation_requests_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- BACKFILL — the tenant's existing seeded default location IS the MAIN pool.
--
-- The new "type" column defaults to 'POS' (the type an admin most often creates),
-- so the ONE pre-existing location per tenant — the seeded default — must be
-- named for what it already is. This is not a guess and not a data rewrite of
-- anything financial: the default location has been the authoritative pool since
-- migration 0007, and isOfflineCapable = false is already the column default,
-- restated here so the row plainly satisfies the MAIN-is-never-offline CHECK
-- below rather than satisfying it by accident of a default.
--
-- No stock, no movement, no journal entry and no quantity is touched.
-- ===========================================================================
UPDATE "locations"
   SET "type" = 'MAIN',
       "isOfflineCapable" = false,
       "leaseWindowMinutes" = NULL
 WHERE "isDefault" = true;

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
--
-- SCOPE NOTE, deliberately recorded: this migration stores LEASE POLICY. It
-- contains NOTHING that expires a lease, freezes an allocation, or reconciles a
-- device. Lease ENFORCEMENT is the offline server task that follows; the seam
-- is described at the top of src/services/locations.ts. A constraint here that
-- silently implied enforcement would be worse than none.
-- ===========================================================================

-- (a) EXACTLY ONE MAIN LOCATION per tenant. MAIN is the authoritative pool that
-- every unstamped movement defaults to and that every allocation draws from; two
-- of them would make "the pool" ambiguous. A partial unique index makes a second
-- one unrepresentable rather than merely refused by the service.
CREATE UNIQUE INDEX one_main_location
  ON "locations" ("type") WHERE "type" = 'MAIN';

-- (b) THE DEFAULT LOCATION IS THE MAIN LOCATION. Same-row check, so it costs
-- nothing. Together with (a) and the pre-existing one_default_location index
-- from migration 0007, this pins "default" and "MAIN" to the same single row —
-- the inventory service's default-location lookup and an allocation's source
-- pool can therefore never drift apart.
ALTER TABLE "locations" ADD CONSTRAINT location_default_is_main
  CHECK ("isDefault" = false OR "type" = 'MAIN');

-- (c) MAIN AND ECOMMERCE ARE NEVER OFFLINE-CAPABLE. MAIN is the authoritative
-- pool held by the server; an e-commerce channel is server-side by definition
-- and is always online. Neither can be a device that goes dark holding stock.
ALTER TABLE "locations" ADD CONSTRAINT location_pool_and_ecommerce_are_online
  CHECK ("type" NOT IN ('MAIN', 'ECOMMERCE') OR "isOfflineCapable" = false);

-- (d) A LEASE WINDOW ONLY MEANS SOMETHING ON AN OFFLINE-CAPABLE LOCATION. The
-- window bounds how long a DISCONNECTED device may hold stock without syncing;
-- on an always-online location there is no such interval to bound. Storing one
-- there would be config that the offline task must then decide to ignore, which
-- is exactly the kind of quietly-dead setting this constraint prevents.
-- Combined with (c) this also guarantees MAIN and ECOMMERCE never carry a lease.
ALTER TABLE "locations" ADD CONSTRAINT location_lease_requires_offline_capable
  CHECK ("leaseWindowMinutes" IS NULL OR "isOfflineCapable" = true);

-- (e) NULL leaseWindowMinutes means FOREVER (this location never freezes); any
-- stored window is a positive number of minutes. Zero or negative would mean
-- "already expired at the moment of allocation", which is not a policy.
ALTER TABLE "locations" ADD CONSTRAINT location_lease_window_positive
  CHECK ("leaseWindowMinutes" IS NULL OR "leaseWindowMinutes" > 0);

-- (f) A daily session window is BOTH ends or NEITHER. A half-open window has no
-- interpretation, and inventing one later ("open until midnight"?) would be a
-- guess baked into live config.
ALTER TABLE "locations" ADD CONSTRAINT location_session_window_paired
  CHECK (("sessionStart" IS NULL) = ("sessionEnd" IS NULL));

-- (g) Session times are 24-hour "HH:MM". Stored as TEXT (a wall-clock time of
-- day, not an instant — it has no date and no timezone), so the format is
-- enforced here rather than by a column type.
ALTER TABLE "locations" ADD CONSTRAINT location_session_time_format
  CHECK (
    ("sessionStart" IS NULL OR "sessionStart" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    AND
    ("sessionEnd"   IS NULL OR "sessionEnd"   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  );

-- (h) A request is for a positive quantity, and an approval grants a positive
-- quantity. Approving zero is not an approval — it is a decline, and it must be
-- recorded as one so the queue reads honestly.
ALTER TABLE "allocation_requests" ADD CONSTRAINT allocation_request_requested_qty_positive
  CHECK ("requestedQty" > 0);

ALTER TABLE "allocation_requests" ADD CONSTRAINT allocation_request_approved_qty_positive
  CHECK ("approvedQty" IS NULL OR "approvedQty" > 0);

-- (i) THE STATE MACHINE, enforced structurally rather than by remembering.
-- Each status pins exactly which decision columns must be present and which must
-- be absent, so a half-written decision (approved with no transfer, declined
-- with a quantity, pending with a decider) cannot exist as a row.
--   PENDING   nothing decided yet.
--   APPROVED  a granted quantity AND the transfer that delivered it. The
--             transferId is what makes the approval auditable: it points at the
--             immutable TRANSFER_IN movement, so "who got what, and when" is
--             answerable from the stock history, not just from this table.
--   DECLINED  a decider, no quantity, and — critically — NO transfer: a declined
--             request moves nothing.
--   CANCELLED the requester withdrew it. decidedBy records WHO took it out of
--             PENDING, which for a cancellation is the requester themselves.
ALTER TABLE "allocation_requests" ADD CONSTRAINT allocation_request_state_consistent
  CHECK (
    ("status" = 'PENDING'
       AND "approvedQty" IS NULL AND "decidedBy" IS NULL
       AND "decidedAt" IS NULL AND "transferId" IS NULL)
    OR
    ("status" = 'APPROVED'
       AND "approvedQty" IS NOT NULL AND "decidedBy" IS NOT NULL
       AND "decidedAt" IS NOT NULL AND "transferId" IS NOT NULL)
    OR
    ("status" IN ('DECLINED', 'CANCELLED')
       AND "approvedQty" IS NULL AND "decidedBy" IS NOT NULL
       AND "decidedAt" IS NOT NULL AND "transferId" IS NULL)
  );

-- (j) A DECIDED REQUEST IS FINAL, and a request's identity never changes.
--
-- This is the database backstop behind "a second decide on the same request is
-- refused". The service checks the status first and returns a clean 409, but the
-- guarantee lives here: without it, two concurrent approvals could each read
-- PENDING and each perform a transfer, allocating the stock twice. The service's
-- check is ergonomics; this trigger is the invariant.
--
-- Two tiers:
--   ALWAYS frozen  — productId, locationId, requestedQty, requestedBy, createdAt.
--                    Editing what was asked for, or by whom, would rewrite the
--                    request an approval was granted against.
--   FROZEN ONCE TERMINAL — status, approvedQty, transferId, decidedBy, decidedAt.
--                    A decision is a historical fact.
-- `note` and `updatedAt` stay mutable so an admin can annotate after the fact.
CREATE OR REPLACE FUNCTION allocation_request_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."productId"    IS DISTINCT FROM OLD."productId"
  OR NEW."locationId"   IS DISTINCT FROM OLD."locationId"
  OR NEW."requestedQty" IS DISTINCT FROM OLD."requestedQty"
  OR NEW."requestedBy"  IS DISTINCT FROM OLD."requestedBy"
  OR NEW."createdAt"    IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION
      'Allocation request %: productId, locationId, requestedQty, requestedBy and createdAt are immutable.',
      OLD.id;
  END IF;

  IF OLD."status" <> 'PENDING' THEN
    IF NEW."status"      IS DISTINCT FROM OLD."status"
    OR NEW."approvedQty" IS DISTINCT FROM OLD."approvedQty"
    OR NEW."transferId"  IS DISTINCT FROM OLD."transferId"
    OR NEW."decidedBy"   IS DISTINCT FROM OLD."decidedBy"
    OR NEW."decidedAt"   IS DISTINCT FROM OLD."decidedAt" THEN
      RAISE EXCEPTION
        'Allocation request % is already %; a decided request is final and cannot be re-decided.',
        OLD.id, OLD."status";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER allocation_request_no_redecide
  BEFORE UPDATE ON allocation_requests
  FOR EACH ROW EXECUTE FUNCTION allocation_request_guard();

-- (k) DELIBERATELY NO immutability trigger on allocation_requests as a whole.
-- Unlike stock_movements (immutable history), this is a WORKFLOW table: a
-- PENDING row is MEANT to change exactly once, when it is decided. The guard
-- above encodes precisely that — one transition out of PENDING, then frozen —
-- rather than a blanket refusal that would make the workflow unimplementable.
