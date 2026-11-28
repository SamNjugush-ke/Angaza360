-- ===========================================================================
-- 0030 — WHICH DRAWER A VOID'S CASH LEFT (Task T-B-SHIFT-VOID). HAND-WRITTEN.
--
-- A shift's expected cash at close is the opening float plus the cash it TOOK, minus the cash
-- it PAID OUT. A void that refunds cash pays it out of a drawer, and until now nothing recorded
-- which one: the close formula assumed the sale's own shift and, because a voided sale was also
-- excluded from the cash taken, a same-shift ring-then-void counted the money out twice.
--
-- `voidShiftId` records the shift whose drawer paid the refund, set ON the void transition and
-- frozen ever after. It must name a shift that is OPEN at that moment (a closed shift's counted
-- cash is settled). NULL on a voided sale means the sale's OWN shift — the NULL-means-default
-- rule: every void before this migration was booked against its own shift, which is exactly what
-- the old formula assumed, so no row is rewritten. A CHECK pins it to voided sales only.
-- ===========================================================================

ALTER TABLE "sales" ADD COLUMN "voidShiftId" TEXT;
ALTER TABLE "sales" ADD CONSTRAINT "sales_voidShiftId_fkey"
  FOREIGN KEY ("voidShiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "sales_voidShiftId_idx" ON "sales"("voidShiftId");

-- Only a voided sale says which drawer refunded it.
ALTER TABLE "sales" ADD CONSTRAINT "sale_void_shift_only_when_voided"
  CHECK ("voidShiftId" IS NULL OR "status"::text = 'VOIDED');

-- ---------------------------------------------------------------------------
-- THE SALE GUARD, extended: 0025's body, plus — on the COMPLETED -> VOIDED transition —
-- `voidShiftId` (when set) must name an OPEN shift, and outside that transition it may never
-- change. The shift is read through TG_TABLE_SCHEMA (schema-safe, the engineering ledger "Raw SQL").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sale_guard_update() RETURNS trigger AS $$
DECLARE
  void_shift_status TEXT;
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
     -- Task 3B.2: the TOT accrued is exactly what a void reverses.
     OR NEW."totAccrued"           IS DISTINCT FROM OLD."totAccrued"
  THEN
    RAISE EXCEPTION 'Sale % is immutable; only voiding, payment settlement, fiscal status and received receivable may change.',
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
    -- Task T-B-SHIFT-VOID: the drawer the cash refund left must be a till that is OPEN.
    IF NEW."voidShiftId" IS NOT NULL THEN
      EXECUTE format('SELECT status::text FROM %I.shifts WHERE id = $1', TG_TABLE_SCHEMA)
        INTO void_shift_status USING NEW."voidShiftId";
      IF void_shift_status IS DISTINCT FROM 'OPEN' THEN
        RAISE EXCEPTION
          'Sale % : the refund must be recorded against an OPEN shift (shift % is %). A closed shift''s counted cash is settled and cannot take a refund.',
          OLD."saleNumber", NEW."voidShiftId", COALESCE(void_shift_status, 'missing');
      END IF;
    END IF;
    -- Task 6: see rule 2 in the note above this function.
    IF OLD."arReceived" > 0 THEN
      RAISE EXCEPTION
        'Sale % cannot be voided: % cents have already been received against its credit balance. Voiding would reverse the receivable while the receipt that settled it stands, leaving account 1100 with a credit balance nothing explains. Refund the customer with a separate document instead.',
        OLD."saleNumber", OLD."arReceived";
    END IF;
  ELSE
    -- status unchanged: the void marker fields must not change here.
    IF NEW."voidedByEntryId" IS DISTINCT FROM OLD."voidedByEntryId"
       OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"
       OR NEW."voidShiftId" IS DISTINCT FROM OLD."voidShiftId"
    THEN
      RAISE EXCEPTION 'Sale % void fields may only change during the COMPLETED -> VOIDED transition.',
        OLD."saleNumber";
    END IF;
  END IF;

  -- Task 4.1: the fiscal transition table.
  IF NEW."fiscalStatus" IS DISTINCT FROM OLD."fiscalStatus" THEN
    IF OLD."fiscalStatus"::text = 'SIGNED' THEN
      RAISE EXCEPTION
        'Sale % is fiscally SIGNED and cannot change fiscal status: KRA holds the invoice. Reverse a signed sale with a CREDIT NOTE, never by downgrading it.',
        OLD."saleNumber";
    END IF;
    IF NOT (
      (OLD."fiscalStatus"::text = 'NOT_REQUESTED'
         AND NEW."fiscalStatus"::text IN ('PENDING_ETIMS', 'SIGNED', 'FAILED'))
      OR
      (OLD."fiscalStatus"::text = 'PENDING_ETIMS'
         AND NEW."fiscalStatus"::text IN ('SIGNED', 'FAILED'))
      OR
      (OLD."fiscalStatus"::text = 'FAILED'
         AND NEW."fiscalStatus"::text IN ('PENDING_ETIMS', 'SIGNED'))
    ) THEN
      RAISE EXCEPTION 'Sale % fiscal status may not move % -> %.',
        OLD."saleNumber", OLD."fiscalStatus", NEW."fiscalStatus";
    END IF;
  END IF;

  -- Task 6: the received receivable only ever goes UP. See rule 1 above.
  IF NEW."arReceived" < OLD."arReceived" THEN
    RAISE EXCEPTION
      'Sale % : the received receivable cannot decrease (% -> % cents). A customer receipt is an immutable posted fact; correct an erroneous one with a separate document, not by rewinding the sale.',
      OLD."saleNumber", OLD."arReceived", NEW."arReceived";
  END IF;

  -- paymentStatus is free to change (settlement lifecycle).
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
