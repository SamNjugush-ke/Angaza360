-- CreateEnum
CREATE TYPE "SalePaymentStatus" AS ENUM ('FULLY_SETTLED', 'PARTIALLY_SETTLED', 'UNSETTLED');

-- CreateEnum
CREATE TYPE "MpesaTxnStatus" AS ENUM ('INITIATED', 'CALLBACK_OK', 'CALLBACK_FAILED', 'TIMED_OUT');

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "paymentStatus" "SalePaymentStatus" NOT NULL DEFAULT 'FULLY_SETTLED';

-- AlterTable
ALTER TABLE "sale_tenders" ADD COLUMN     "mpesaTransactionId" TEXT;

-- CreateTable
CREATE TABLE "mpesa_transactions" (
    "id" TEXT NOT NULL,
    "saleId" TEXT,
    "tenderId" TEXT,
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "accountReference" TEXT NOT NULL,
    "status" "MpesaTxnStatus" NOT NULL DEFAULT 'INITIATED',
    "resultCode" INTEGER,
    "resultDesc" TEXT,
    "mpesaReceiptNumber" TEXT,
    "callbackRawJson" TEXT,
    "confirmationEntryId" TEXT,
    "reversalEntryId" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "mpesa_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_transactions_tenderId_key" ON "mpesa_transactions"("tenderId");

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_transactions_checkoutRequestId_key" ON "mpesa_transactions"("checkoutRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_transactions_mpesaReceiptNumber_key" ON "mpesa_transactions"("mpesaReceiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_transactions_confirmationEntryId_key" ON "mpesa_transactions"("confirmationEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_transactions_reversalEntryId_key" ON "mpesa_transactions"("reversalEntryId");

-- CreateIndex
CREATE INDEX "mpesa_transactions_status_idx" ON "mpesa_transactions"("status");

-- CreateIndex
CREATE INDEX "mpesa_transactions_saleId_idx" ON "mpesa_transactions"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_tenders_mpesaTransactionId_key" ON "sale_tenders"("mpesaTransactionId");

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- (a) An STK amount is always positive.
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT mpesa_amount_positive
  CHECK (amount > 0);

-- (b) A row cannot be marked CALLBACK_OK without a receipt and a zero result
-- code — success is only success with proof.
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT mpesa_ok_requires_receipt
  CHECK (
    (status = 'CALLBACK_OK' AND "mpesaReceiptNumber" IS NOT NULL AND "resultCode" = 0)
    OR (status <> 'CALLBACK_OK')
  );

-- (c) Immutability-lite. A transaction may move from INITIATED to a terminal
-- state exactly once; a terminal row is final (a replayed/duplicate callback
-- must be a no-op, enforced in the service and backstopped here). The request
-- fields (checkoutRequestId, amount, saleId) never change.
CREATE OR REPLACE FUNCTION mpesa_txn_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW."checkoutRequestId" IS DISTINCT FROM OLD."checkoutRequestId"
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW."saleId" IS DISTINCT FROM OLD."saleId"
  THEN
    RAISE EXCEPTION 'M-Pesa transaction % request fields (checkoutRequestId/amount/saleId) are immutable.',
      OLD."checkoutRequestId";
  END IF;

  IF OLD.status::text <> 'INITIATED' THEN
    RAISE EXCEPTION 'M-Pesa transaction % is already in terminal state %; it cannot be modified.',
      OLD."checkoutRequestId", OLD.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mpesa_txn_no_terminal_overwrite
  BEFORE UPDATE ON mpesa_transactions
  FOR EACH ROW EXECUTE FUNCTION mpesa_txn_guard_update();

-- (d) Replace the sale immutability guard (from 0006) so it ALSO permits the
-- paymentStatus settlement transition. paymentStatus is a mutable lifecycle flag
-- (an M-Pesa STK settles asynchronously after the sale row is written); every
-- FINANCIAL field stays immutable, exactly as before. The void transition is
-- unchanged. This is not a weakening — it adds a designed-mutable, non-financial
-- lifecycle column to the same allow-list that already carries the void fields.
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

-- (e) Sale tenders were write-once in 0006, but an MPESA tender is created
-- PENDING precisely so 3.3 can settle it — the tender lifecycle was always meant
-- to transition. Replace the tender's blanket write-once trigger with a guard
-- that permits ONLY the settlement transitions: status PENDING -> CONFIRMED or
-- PENDING -> FAILED, and mpesaTransactionId NULL -> value (set once). Every
-- FINANCIAL/identity field (saleId, tenderType, amount, createdAt) stays
-- immutable, and DELETE is still forbidden. sale_lines remain fully write-once
-- (their trigger, sale_line_no_change, is untouched). This completes the 3.2
-- design; it does not weaken it.
DROP TRIGGER sale_tender_no_change ON sale_tenders;

CREATE OR REPLACE FUNCTION sale_tender_guard_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Sale tenders are write-once and cannot be deleted.';
  END IF;

  IF NEW.id             IS DISTINCT FROM OLD.id
     OR NEW."saleId"    IS DISTINCT FROM OLD."saleId"
     OR NEW."tenderType" IS DISTINCT FROM OLD."tenderType"
     OR NEW.amount      IS DISTINCT FROM OLD.amount
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Sale tender % is immutable except its payment-settlement fields.', OLD.id;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status::text = 'PENDING' AND NEW.status::text IN ('CONFIRMED', 'FAILED')) THEN
      RAISE EXCEPTION 'Sale tender % status may only transition PENDING -> CONFIRMED/FAILED.', OLD.id;
    END IF;
  END IF;

  IF OLD."mpesaTransactionId" IS NOT NULL
     AND NEW."mpesaTransactionId" IS DISTINCT FROM OLD."mpesaTransactionId"
  THEN
    RAISE EXCEPTION 'Sale tender % is already linked to an STK transaction.', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sale_tender_guard
  BEFORE UPDATE OR DELETE ON sale_tenders
  FOR EACH ROW EXECUTE FUNCTION sale_tender_guard_update();
