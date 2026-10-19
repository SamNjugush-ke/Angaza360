-- CreateEnum
CREATE TYPE "SaleFiscalStatus" AS ENUM ('NOT_REQUESTED', 'PENDING_ETIMS', 'SIGNED', 'FAILED');

-- CreateEnum
CREATE TYPE "EtimsInvoiceStatus" AS ENUM ('PENDING', 'SIGNED', 'REJECTED', 'QUEUED', 'FAILED');

-- CreateEnum
CREATE TYPE "EtimsInvoiceType" AS ENUM ('SALE', 'CREDIT_NOTE');

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "fiscalStatus" "SaleFiscalStatus" NOT NULL DEFAULT 'NOT_REQUESTED';

-- CreateTable
CREATE TABLE "etims_devices" (
    "id" TEXT NOT NULL,
    "tin" TEXT NOT NULL,
    "bhfId" TEXT NOT NULL,
    "dvcSrlNo" TEXT NOT NULL,
    "initialized" BOOLEAN NOT NULL DEFAULT false,
    "lastInitAt" TIMESTAMP(3),
    "lastInvoiceNo" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "etims_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "etims_invoices" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "invoiceType" "EtimsInvoiceType" NOT NULL DEFAULT 'SALE',
    "originalInvoiceId" TEXT,
    "etimsDeviceId" TEXT NOT NULL,
    "etimsInvoiceNumber" INTEGER NOT NULL,
    "status" "EtimsInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "kraReceiptNumber" TEXT,
    "rcptSign" TEXT,
    "intrlData" TEXT,
    "sdcDateTime" TEXT,
    "qrCodeUrl" TEXT,
    "resultCode" TEXT,
    "resultMsg" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "submittedPayload" TEXT,
    "rawResponse" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "etims_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "etims_devices_tin_bhfId_dvcSrlNo_key" ON "etims_devices"("tin", "bhfId", "dvcSrlNo");

-- CreateIndex
CREATE INDEX "etims_invoices_saleId_idx" ON "etims_invoices"("saleId");

-- CreateIndex
CREATE INDEX "etims_invoices_status_idx" ON "etims_invoices"("status");

-- CreateIndex
CREATE INDEX "etims_invoices_etimsInvoiceNumber_idx" ON "etims_invoices"("etimsInvoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "etims_invoices_etimsDeviceId_etimsInvoiceNumber_key" ON "etims_invoices"("etimsDeviceId", "etimsInvoiceNumber");

-- AddForeignKey
ALTER TABLE "etims_invoices" ADD CONSTRAINT "etims_invoices_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etims_invoices" ADD CONSTRAINT "etims_invoices_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "etims_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etims_invoices" ADD CONSTRAINT "etims_invoices_etimsDeviceId_fkey" FOREIGN KEY ("etimsDeviceId") REFERENCES "etims_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- NO BACKFILL, DELIBERATELY — NULL/DEFAULT MEANS NOT_REQUESTED.
--
-- eTIMS is OPT-IN PER SALE and is the MINORITY case: most MSME sales are
-- informal, carry no buyer PIN, and are validly finalized with no fiscal invoice
-- at all. Every sale recorded before this column existed was finalized exactly
-- that way, so the NOT_REQUESTED default already states the truth about all of
-- them. Writing anything else into historical sales would claim a KRA invoice
-- had been asked for when none ever was.
--
-- Same NULL-means-default pattern as locationId on stock_movements (0007),
-- lineCogs on sale_lines (0012), sellingLocationId on sales (0014) and the
-- offline dimensions (0015).
-- ===========================================================================

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- (a) INVOICE NUMBERS ARE POSITIVE. KRA's numbering starts at 1 and counts up
-- per device; zero or negative is not a number KRA will ever accept, and it
-- would mean the allocator read an uninitialised counter.
ALTER TABLE "etims_invoices" ADD CONSTRAINT etims_invoice_number_positive
  CHECK ("etimsInvoiceNumber" > 0);

ALTER TABLE "etims_devices" ADD CONSTRAINT etims_device_counter_non_negative
  CHECK ("lastInvoiceNo" >= 0);

ALTER TABLE "etims_invoices" ADD CONSTRAINT etims_invoice_retry_count_non_negative
  CHECK ("retryCount" >= 0);

-- (b) AT MOST ONE *SALE* INVOICE PER SALE.
--
-- A sale is filed with KRA exactly once; filing it twice would double-report the
-- same revenue. A sale may additionally carry CREDIT NOTES (a void of a signed
-- sale), so the constraint is a PARTIAL unique index on the SALE type rather
-- than a blanket unique on saleId — which would have made the fiscal reversal
-- unrepresentable.
CREATE UNIQUE INDEX one_sale_invoice_per_sale
  ON "etims_invoices" ("saleId") WHERE "invoiceType" = 'SALE';

-- (c) A CREDIT NOTE REFERENCES THE INVOICE IT REVERSES; A SALE INVOICE DOES NOT.
--
-- KRA requires a credit note to name the original invoice, and it must be filed
-- from the same solution that filed that original. A credit note with no
-- reference is unfileable; a sale invoice that references another is incoherent.
ALTER TABLE "etims_invoices" ADD CONSTRAINT etims_invoice_credit_note_references_original
  CHECK (
    ("invoiceType" = 'SALE'        AND "originalInvoiceId" IS NULL)
    OR
    ("invoiceType" = 'CREDIT_NOTE' AND "originalInvoiceId" IS NOT NULL)
  );

-- (d) A SIGNED INVOICE CARRIES KRA'S ARTIFACTS; AN UNSIGNED ONE CARRIES NONE.
--
-- "SIGNED" with no receipt number and no signature would be a claim of fiscal
-- compliance with nothing behind it — the single most dangerous row this table
-- could hold, because a report would count it as filed. Equally, a PENDING or
-- QUEUED row must not carry artifacts it was never given.
--
-- rcptSign and kraReceiptNumber are the two KRA always returns on success and are
-- therefore the two required here; intrlData, sdcDateTime and qrCodeUrl are
-- present in practice but are not made mandatory, because a constraint that
-- depends on a field KRA might omit would reject a genuinely signed invoice.
ALTER TABLE "etims_invoices" ADD CONSTRAINT etims_invoice_signed_has_artifacts
  CHECK (
    ("status" = 'SIGNED'
       AND "kraReceiptNumber" IS NOT NULL AND "rcptSign" IS NOT NULL)
    OR
    ("status" <> 'SIGNED'
       AND "kraReceiptNumber" IS NULL AND "rcptSign" IS NULL)
  );

-- (e) A REJECTED INVOICE SAYS WHY.
--
-- REJECTED means KRA was REACHABLE and refused the payload, so KRA told us a
-- reason. An operator cannot fix a rejection they cannot read, and "rejected for
-- unknown reasons" is how a fiscal backlog becomes permanent.
ALTER TABLE "etims_invoices" ADD CONSTRAINT etims_invoice_rejected_has_reason
  CHECK ("status" <> 'REJECTED' OR "resultMsg" IS NOT NULL);

-- (f) A SIGNED FISCAL RECORD IS PERMANENT AND UNEDITABLE.
--
-- This is the heart of the table. Once KRA has signed an invoice, that invoice
-- IS the filed fiscal record: the receipt number, the signature, the internal
-- data, the timestamp and the number are what KRA holds on its side. Editing any
-- of them locally would make our books disagree with KRA's while still looking
-- internally consistent — the failure mode nobody notices until an audit.
--
-- WHAT IS FROZEN ONCE SIGNED: status, the invoice number, the device, the sale,
-- the invoice type, the original-invoice reference, and every KRA artifact.
-- WHAT STAYS MUTABLE ONCE SIGNED: nothing of substance — only updatedAt. (A
-- signed invoice needs no retry and has no reason to be annotated here; the
-- credit-note row is where a later reversal is recorded.)
--
-- WHAT IS FROZEN ALWAYS, at every status: saleId, etimsDeviceId,
-- etimsInvoiceNumber, invoiceType, createdBy, createdAt. The NUMBER in
-- particular is frozen from allocation, not from signing, and that is the
-- NO-DOUBLE-FILE guarantee: a retry after a connectivity failure MUST resubmit
-- the number it already allocated. Letting a retry take a fresh number would
-- file the same sale with KRA twice under two numbers.
--
-- WHAT MAY MOVE WHILE UNSIGNED: status among PENDING/QUEUED/REJECTED/FAILED (and
-- forward to SIGNED), retryCount, lastAttemptAt, the KRA result fields, and the
-- submitted/raw payload audit columns.
CREATE OR REPLACE FUNCTION etims_invoice_guard_update() RETURNS trigger AS $$
BEGIN
  -- Identity is immutable at every status. The number is part of identity.
  IF NEW."saleId"             IS DISTINCT FROM OLD."saleId"
     OR NEW."etimsDeviceId"      IS DISTINCT FROM OLD."etimsDeviceId"
     OR NEW."etimsInvoiceNumber" IS DISTINCT FROM OLD."etimsInvoiceNumber"
     OR NEW."invoiceType"        IS DISTINCT FROM OLD."invoiceType"
     OR NEW."createdBy"          IS DISTINCT FROM OLD."createdBy"
     OR NEW."createdAt"          IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'eTIMS invoice % identity is immutable: sale, device, invoice number and type never change. A retry MUST resubmit the number it was allocated — reallocating one double-files the sale with KRA.',
      OLD.id;
  END IF;

  -- A SIGNED invoice is a permanent fiscal record.
  IF OLD."status" = 'SIGNED' THEN
    IF NEW."status"            IS DISTINCT FROM OLD."status"
       OR NEW."kraReceiptNumber"  IS DISTINCT FROM OLD."kraReceiptNumber"
       OR NEW."rcptSign"          IS DISTINCT FROM OLD."rcptSign"
       OR NEW."intrlData"         IS DISTINCT FROM OLD."intrlData"
       OR NEW."sdcDateTime"       IS DISTINCT FROM OLD."sdcDateTime"
       OR NEW."qrCodeUrl"         IS DISTINCT FROM OLD."qrCodeUrl"
       OR NEW."originalInvoiceId" IS DISTINCT FROM OLD."originalInvoiceId"
       OR NEW."resultCode"        IS DISTINCT FROM OLD."resultCode"
       OR NEW."resultMsg"         IS DISTINCT FROM OLD."resultMsg"
       OR NEW."retryCount"        IS DISTINCT FROM OLD."retryCount"
       OR NEW."lastAttemptAt"     IS DISTINCT FROM OLD."lastAttemptAt"
       OR NEW."submittedPayload"  IS DISTINCT FROM OLD."submittedPayload"
       OR NEW."rawResponse"       IS DISTINCT FROM OLD."rawResponse"
    THEN
      RAISE EXCEPTION
        'eTIMS invoice % is SIGNED and is a permanent fiscal record: KRA holds this receipt number and signature, so nothing about it may be edited. Correct a signed invoice with a CREDIT NOTE, never by rewriting it.',
        OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER etims_invoice_guard
  BEFORE UPDATE ON etims_invoices
  FOR EACH ROW EXECUTE FUNCTION etims_invoice_guard_update();

-- A fiscal record is never deleted — not a signed one, and not an unsigned one
-- either, because an allocated invoice NUMBER must stay accounted for. Deleting a
-- QUEUED row would silently retire a number KRA may already have seen, and
-- deleting a SIGNED row would erase the local half of a filing KRA still holds.
-- The gap it left would be unexplainable at audit.
CREATE OR REPLACE FUNCTION etims_invoice_guard_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'eTIMS invoice % (number %, status %) cannot be deleted: a fiscal record is permanent, and an allocated invoice number must remain accounted for.',
    OLD.id, OLD."etimsInvoiceNumber", OLD."status";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER etims_invoice_no_delete
  BEFORE DELETE ON etims_invoices
  FOR EACH ROW EXECUTE FUNCTION etims_invoice_guard_delete();

-- (g) THE SALE GUARD LEARNS ABOUT fiscalStatus, AND NOTHING ELSE BECOMES MUTABLE.
--
-- This replaces sale_guard_update() (last replaced in 0015, which froze the
-- offline provenance columns) to permit the fiscal transitions below. Every
-- financial and identity field stays exactly as frozen as it was — this is the
-- same shape of extension 0009 made for paymentStatus and 0014/0015 made for the
-- location and offline columns.
--
-- THE PERMITTED TRANSITION TABLE, and why each one exists:
--   NOT_REQUESTED -> PENDING_ETIMS   a cashier asked for a KRA invoice after the
--                                    fact (POST /v1/etims/sales/:id/sign on a
--                                    sale that was not flagged at the till).
--   NOT_REQUESTED -> SIGNED | FAILED the same request, resolved in one step
--                                    because signing is a single service call.
--   PENDING_ETIMS -> SIGNED | FAILED the ordinary resolution of a request.
--   FAILED        -> PENDING_ETIMS   an operator fixed the cause and resubmitted.
--   FAILED        -> SIGNED          that resubmission succeeded.
--   SIGNED        -> TERMINAL.       A signed sale can never be un-signed: KRA
--                                    holds the invoice. The fiscal reversal of a
--                                    signed sale is a CREDIT NOTE, which is a new
--                                    row in etims_invoices, never a downgrade
--                                    here.
--
-- Note what is NOT permitted: PENDING_ETIMS -> NOT_REQUESTED. A request, once
-- made, is a fact about the sale; withdrawing it would hide an unmet fiscal
-- obligation from the operator's dashboard.
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
    RAISE EXCEPTION 'Sale % is immutable; only voiding, payment settlement and fiscal status may change.',
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

  -- Task 4.1: the fiscal transition table above.
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

  -- paymentStatus is free to change (settlement lifecycle).
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (h) DELIBERATELY NO CONSTRAINT tying Sale.fiscalStatus to the existence of an
-- EtimsInvoice row.
--
-- They are maintained together by one service in one transaction, but a CHECK
-- cannot see another table and a cross-table trigger here would fire on the POS
-- sale path — the hottest write in the system — to enforce something only the
-- eTIMS service can violate. The same considered trade-off as the aggregate stock
-- invariant in 0011: the database enforces what is cheap and local (the artifact,
-- reason, reference and immutability rules above), and the cross-table agreement
-- is an acceptance criterion. Recorded so it is not mistaken for an oversight.
