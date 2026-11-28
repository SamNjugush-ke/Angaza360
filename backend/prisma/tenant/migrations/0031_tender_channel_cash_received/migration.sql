-- ===========================================================================
-- 0031 — TENDER CHANNEL AND CASH RECEIVED (Task T-B-POS-PAY-A). HAND-WRITTEN.
--
-- Two optional facts about HOW a tender was paid, recorded on the tender row itself:
--
--   * mpesaChannel — for an MPESA tender, which M-Pesa route the money came by: STK (the
--     till pushed a prompt to the customer's phone), TILL (Buy Goods) or PAYBILL, keyed in by
--     the cashier against the customer's confirmation SMS.
--   * cashReceived — for a CASH tender, the physical cash handed over. The tender AMOUNT is
--     what the sale is settled at (tenders still sum to the total to the cent); cashReceived
--     is the note the customer gave, so the receipt's change is a recorded fact rather than
--     the till's arithmetic.
--
-- EXISTING ROWS: both columns are NULL for every tender written before this migration, and
-- NULL is the truth for them — no channel or cash-received figure was ever recorded. No row
-- is rewritten (NULL-means-not-recorded; tenders are write-once).
-- ===========================================================================

CREATE TYPE "MpesaChannel" AS ENUM ('STK', 'TILL', 'PAYBILL');

ALTER TABLE "sale_tenders" ADD COLUMN "mpesaChannel" "MpesaChannel";
ALTER TABLE "sale_tenders" ADD COLUMN "cashReceived" BIGINT;

-- A CHANNEL BELONGS ONLY TO AN M-PESA TENDER.
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tender_channel_only_mpesa" CHECK (
  "mpesaChannel" IS NULL OR "tenderType"::text = 'MPESA'
);

-- CASH RECEIVED BELONGS ONLY TO A CASH TENDER, AND COVERS IT. Handing over less than the
-- tender settles is not a cash tender; the change is cashReceived − amount, never negative.
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tender_cash_received_covers_cash" CHECK (
  "cashReceived" IS NULL OR ("tenderType"::text = 'CASH' AND "cashReceived" >= "amount")
);

-- BOTH ARE WRITE-ONCE: set when the tender is inserted, then frozen, with NO update
-- transition — the same discipline as the tender's identity fields. The guard from 0009 is
-- replaced whole; everything it already enforced is kept unchanged.
CREATE OR REPLACE FUNCTION sale_tender_guard_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Sale tenders are write-once and cannot be deleted.';
  END IF;

  IF NEW.id               IS DISTINCT FROM OLD.id
     OR NEW."saleId"      IS DISTINCT FROM OLD."saleId"
     OR NEW."tenderType"  IS DISTINCT FROM OLD."tenderType"
     OR NEW.amount        IS DISTINCT FROM OLD.amount
     OR NEW."createdAt"   IS DISTINCT FROM OLD."createdAt"
     OR NEW."mpesaChannel" IS DISTINCT FROM OLD."mpesaChannel"
     OR NEW."cashReceived" IS DISTINCT FROM OLD."cashReceived"
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
