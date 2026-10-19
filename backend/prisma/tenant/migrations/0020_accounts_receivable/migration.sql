-- CreateEnum
CREATE TYPE "CustomerReceiptMethod" AS ENUM ('CASH', 'BANK', 'MPESA');

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "arReceived" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "customer_receipts" (
    "id" TEXT NOT NULL,
    "receiptNumber" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "receiptDate" TIMESTAMP(3) NOT NULL,
    "method" "CustomerReceiptMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_receipt_allocations" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_receipt_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_receipts_receiptNumber_key" ON "customer_receipts"("receiptNumber");

-- CreateIndex
CREATE INDEX "customer_receipts_customerId_idx" ON "customer_receipts"("customerId");

-- CreateIndex
CREATE INDEX "customer_receipts_receiptDate_idx" ON "customer_receipts"("receiptDate");

-- CreateIndex
CREATE INDEX "customer_receipt_allocations_saleId_idx" ON "customer_receipt_allocations"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_receipt_allocations_receiptId_saleId_key" ON "customer_receipt_allocations"("receiptId", "saleId");

-- AddForeignKey
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "customer_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- NO BACKFILL, DELIBERATELY.
--
-- `arReceived` defaults to 0 on every existing sale, and 0 IS THE TRUTH about them:
-- customer receipts did not exist before this migration, so nothing has been
-- received against any credit sale through this path. Writing anything else would
-- invent a collection history and would immediately break the subledger
-- reconciliation below.
--
-- The `creditBalance` each customer already carries is therefore correctly described
-- as fully outstanding, and collecting it is a receipt posted from here on — not a
-- retroactive adjustment. Same discipline as `locationId` on stock_movements (0007),
-- `lineCogs` on sale_lines (0012), `sellingLocationId` on sales (0014), the offline
-- dimensions (0015), `fiscalStatus` (0016), the procurement links (0017) and
-- `billedQty` on purchase order lines (0018).
-- ===========================================================================

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix). Cross-table trigger bodies qualify by TG_TABLE_SCHEMA, because the pg
-- adapter does not set search_path (the engineering ledger "Raw SQL and Tenant Schema
-- Resolution").
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) NO NEW ACCOUNTS, AND NO NEW CUSTOMER CONSTRAINT EITHER.
--
-- Accounts receivable posts to 1100 and to 1000 / 1020 / 1010, all of which came
-- with the chart in Phase 2.1. The chart stays at 46.
--
-- `creditBalance >= 0` is ALREADY guaranteed: `customer_credit_coherent` (migration
-- 0006) CHECKs it alongside `creditLimit >= 0`. The service's "a receipt may not
-- drive creditBalance negative" rule is therefore ergonomics over an existing
-- database guarantee, which is the right way round — nothing is re-declared here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- (b) PER-SCHEMA RECEIPT NUMBER SEQUENCE.
--
-- The same mechanism as `purchase_order_number_seq` / `goods_receipt_number_seq`
-- (0017), `supplier_payment_number_seq` (0018) and `journal_entry_seq` (0003):
-- monotonic and unique, NOT gap-free, because a sequence is non-transactional and a
-- receipt whose transaction rolls back burns its number. The gap-free row-locked
-- counter used for KRA fiscal invoice numbers (0016) is not warranted — a missing
-- internal receipt number has no regulatory meaning.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE customer_receipt_number_seq START 1;

-- ---------------------------------------------------------------------------
-- (c) SALE FIELD CONSTRAINT.
-- ---------------------------------------------------------------------------
ALTER TABLE "sales" ADD CONSTRAINT sale_ar_received_non_negative
  CHECK ("arReceived" >= 0);

-- ---------------------------------------------------------------------------
-- (d) THE SALE GUARD LEARNS ABOUT `arReceived`, AND NOTHING ELSE BECOMES MUTABLE.
--
-- This replaces sale_guard_update() (last replaced in 0016, which added the fiscal
-- transition table; 0015 added the offline dimensions and 0014 the selling
-- location). The frozen set is UNCHANGED, character for character. Two rules are
-- ADDED, both of them restrictions rather than permissions:
--
--   1. `arReceived` MAY ONLY RISE. A posted customer receipt is settled cash with a
--      journal entry behind it, so walking the figure back would leave the ledger
--      claiming a collection the sale denies. Same rule, same reason, as
--      `PurchaseOrderLine.receivedQty` (0017) and `SupplierBill.amountPaid` (0018).
--      (Contrast `billedQty` in 0018, which IS allowed to fall because a posted bill
--      can be cancelled — there is no corresponding cancel for a receipt, because
--      customer credit notes are deliberately out of this task's scope.)
--
--   2. A SALE THAT HAS RECEIVED MONEY CANNOT BE VOIDED. This closes a hole that
--      `arReceived` ITSELF OPENS, and it is the most important line in this
--      migration. The void reverses the original `Dr 1100` and `sales.ts` drops the
--      customer's `creditBalance` by the FULL credit-tender amount — but the
--      receipt's `Cr 1100` and its `Dr cash` stay exactly where they are, because a
--      receipt is immutable. Net effect on 1100: minus the amount received, i.e. an
--      ASSET ACCOUNT CARRYING A CREDIT BALANCE that no document explains, and a
--      customer subledger that can never be made to tie again.
--
--      It is a SAME-ROW test (`OLD."arReceived" > 0` during the COMPLETED -> VOIDED
--      transition), so it is cheap and local and belongs in this guard rather than
--      in a cross-table trigger. The service returns the clean 409; THIS is the
--      guarantee. Refunding a customer who has already paid is a refund document,
--      which is deferred along with credit notes.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- (e) CUSTOMER RECEIPT FIELD CONSTRAINTS AND TOTAL IMMUTABILITY.
--
-- Template: supplier_payment_immutable (0018), goods_receipt_immutable (0017),
-- etims_invoice_no_delete (0016), the stock-movement immutability trigger (0005).
-- A receipt records that money ARRIVED and has a journal entry behind it. Editing it
-- would leave that entry describing a collection that no longer claims to have
-- happened; deleting it would orphan the entry and silently un-settle every sale its
-- allocations paid, while the cash stayed in the books.
-- ---------------------------------------------------------------------------
ALTER TABLE "customer_receipts" ADD CONSTRAINT customer_receipt_number_positive
  CHECK ("receiptNumber" > 0);

-- Strictly positive. A negative receipt would be a refund TO the customer, which is
-- a different document with a different ledger effect (Dr 1100 / Cr cash), and
-- expressing it as a negative receipt would make every cash-in report wrong.
ALTER TABLE "customer_receipts" ADD CONSTRAINT customer_receipt_amount_positive
  CHECK ("amount" > 0);

CREATE OR REPLACE FUNCTION customer_receipt_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Customer receipt RCT-% is immutable: it records that money arrived and it has a journal entry behind it. Correct an erroneous receipt with a separate document, never by editing the receipt.',
      OLD."receiptNumber";
  END IF;
  RAISE EXCEPTION
    'Customer receipt RCT-% cannot be deleted: its journal entry would be orphaned, the cash it recorded would stay in the books, and every sale its allocations settled would silently become unpaid.',
    OLD."receiptNumber";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_receipt_no_update
  BEFORE UPDATE ON customer_receipts
  FOR EACH ROW EXECUTE FUNCTION customer_receipt_immutable();

CREATE TRIGGER customer_receipt_no_delete
  BEFORE DELETE ON customer_receipts
  FOR EACH ROW EXECUTE FUNCTION customer_receipt_immutable();

-- ---------------------------------------------------------------------------
-- (f) ALLOCATION FIELD CONSTRAINT.
-- ---------------------------------------------------------------------------
ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT customer_receipt_allocation_amount_positive
  CHECK ("amount" > 0);

-- ---------------------------------------------------------------------------
-- (g) THE ALLOCATION GUARD: write-once, and only ever against a COMPLETED CREDIT
-- sale belonging to the SAME customer as the receipt.
--
-- WHY THE CUSTOMER MUST MATCH, and this is not defensive decoration: the service
-- reduces the RECEIPT'S customer's `creditBalance` by the receipt amount, while the
-- allocation raises the SALE'S `arReceived`. Point a receipt from customer A at
-- customer B's sale and A's balance falls while B's sale is marked collected — two
-- customers' subledgers wrong, GL 1100 still perfectly balanced, and nothing in the
-- trial balance to reveal it. That is the worst kind of error, so it is
-- unrepresentable rather than merely checked.
--
-- WHY A CREDIT SALE: a cash sale was settled at the till and raised no receivable,
-- so there is nothing to collect. Allocating to one would push `arReceived` above a
-- receivable of zero — which the deferred cap in (h) would also catch, but this
-- names the actual mistake instead of reporting arithmetic.
--
-- WHY COMPLETED: a VOIDED sale's receivable has been reversed. (A sale can only be
-- voided while `arReceived = 0`, per (d), so this and that rule close the loop from
-- both ends: you cannot void a collected sale, and you cannot collect a voided one.)
--
-- Write-once is merged into the same function: an allocation says "this much of that
-- receipt settled this sale", and changing one would move settlement between sales
-- without moving any money.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION customer_receipt_allocation_guard() RETURNS trigger AS $$
DECLARE
  v_schema          text := TG_TABLE_SCHEMA;
  v_receipt_number  integer;
  v_receipt_cust    text;
  v_sale_number     text;
  v_sale_status     text;
  v_sale_cust       text;
  v_credit_tenders  bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Receipt allocation % is write-once: it is part of a posted receipt. Re-allocating settlement between sales without moving money would falsify the customer''s balance.',
      OLD."id";
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- A cascade from deleting the receipt itself cannot happen (the receipt refuses
    -- DELETE outright), so any delete reaching here is a direct one.
    RAISE EXCEPTION
      'Receipt allocation % cannot be deleted: the sale it settled would silently become unpaid while the receipt that settled it still exists.',
      OLD."id";
  END IF;

  EXECUTE format('SELECT "receiptNumber", "customerId" FROM %I.customer_receipts WHERE "id" = $1', v_schema)
    INTO v_receipt_number, v_receipt_cust USING NEW."receiptId";
  IF v_receipt_number IS NULL THEN
    RAISE EXCEPTION 'Receipt allocation references customer receipt %, which does not exist.',
      NEW."receiptId";
  END IF;

  EXECUTE format('SELECT "saleNumber", "status"::text, "customerId" FROM %I.sales WHERE "id" = $1', v_schema)
    INTO v_sale_number, v_sale_status, v_sale_cust USING NEW."saleId";
  IF v_sale_number IS NULL THEN
    RAISE EXCEPTION 'Receipt allocation references sale %, which does not exist.', NEW."saleId";
  END IF;

  IF v_sale_status <> 'COMPLETED' THEN
    RAISE EXCEPTION
      'Customer receipt RCT-% cannot be allocated to sale %: it is % , so its receivable has been reversed and there is nothing to collect.',
      v_receipt_number, v_sale_number, v_sale_status;
  END IF;

  IF v_sale_cust IS NULL OR v_sale_cust <> v_receipt_cust THEN
    RAISE EXCEPTION
      'Customer receipt RCT-% cannot be allocated to sale %: the sale belongs to a different customer. A receipt settles only the account of the customer who paid it.',
      v_receipt_number, v_sale_number;
  END IF;

  EXECUTE format(
    'SELECT COALESCE(SUM("amount"), 0) FROM %I.sale_tenders WHERE "saleId" = $1 AND "tenderType" = ''CREDIT''',
    v_schema)
    INTO v_credit_tenders USING NEW."saleId";
  IF v_credit_tenders <= 0 THEN
    RAISE EXCEPTION
      'Customer receipt RCT-% cannot be allocated to sale %: it has no CREDIT tender, so it raised no receivable. It was settled at the till.',
      v_receipt_number, v_sale_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_receipt_allocation_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON customer_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION customer_receipt_allocation_guard();

-- ---------------------------------------------------------------------------
-- (h) DEFERRED CONSTRAINT: EVERY SHILLING OF A RECEIPT IS ALLOCATED.
--
-- `SUM(allocations.amount) = receipt.amount`, checked at COMMIT. Same mechanism as
-- `journal_balance_check` (0003, made schema-safe in 0004) and the payables
-- constraints (0018/0019): the rows arrive in several statements, so the rule can
-- only be evaluated once they are all present, and DEFERRABLE INITIALLY DEFERRED is
-- what lets a correct multi-statement write succeed while any transaction that would
-- leave an inconsistency fails atomically at COMMIT.
--
-- **THE 0019 LESSON, APPLIED UP FRONT AND BY DESIGN.** Task 5.2 bound its equivalent
-- constraint ONLY to the allocations table, which CANNOT FIRE for a payment that has
-- no allocation rows at all — so an unallocated payment was accepted by the database
-- and had to be closed by a follow-up migration after the adversarial acceptance
-- caught it. The lesson generalises: **an aggregate constraint must be bound to EVERY
-- table whose rows can make it false, and the function must resolve its subject from
-- `TG_TABLE_NAME` rather than from a column that only one of those tables has.** Both
-- bindings are created here, in the first migration, and a receipt inserted with zero
-- allocations is refused.
--
-- An under-allocated receipt is cash recorded as arriving with no customer's balance
-- reduced: the subledger stays overstated and the aging report keeps chasing someone
-- who has paid. An over-allocated one settles sales with money that never arrived.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_receipt_fully_allocated() RETURNS trigger AS $$
DECLARE
  v_schema     text := TG_TABLE_SCHEMA;
  v_receipt_id text;
  v_number     integer;
  v_amount     bigint;
  v_allocated  bigint;
BEGIN
  IF TG_TABLE_NAME = 'customer_receipts' THEN
    -- A deleted receipt has nothing left to validate, and the immutability trigger
    -- refuses the delete anyway.
    IF TG_OP = 'DELETE' THEN
      RETURN NULL;
    END IF;
    v_receipt_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    v_receipt_id := OLD."receiptId";
  ELSE
    v_receipt_id := NEW."receiptId";
  END IF;

  EXECUTE format('SELECT "receiptNumber", "amount" FROM %I.customer_receipts WHERE "id" = $1', v_schema)
    INTO v_number, v_amount USING v_receipt_id;

  -- Parent receipt gone: nothing to validate (it cannot happen while the
  -- immutability trigger stands, but the guard costs nothing).
  IF v_number IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT COALESCE(SUM("amount"), 0) FROM %I.customer_receipt_allocations WHERE "receiptId" = $1', v_schema)
    INTO v_allocated USING v_receipt_id;

  IF v_allocated <> v_amount THEN
    RAISE EXCEPTION
      'Customer receipt RCT-% is % cents but % cents are allocated to sales (difference % cents). Every shilling received must be pointed at a credit sale: there is no on-account customer balance.',
      v_number, v_amount, v_allocated, (v_amount - v_allocated);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER receipt_fully_allocated_check_on_allocation
  AFTER INSERT OR UPDATE OR DELETE ON customer_receipt_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_receipt_fully_allocated();

CREATE CONSTRAINT TRIGGER receipt_fully_allocated_check_on_receipt
  AFTER INSERT OR UPDATE ON customer_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_receipt_fully_allocated();

-- ---------------------------------------------------------------------------
-- (i) DEFERRED CONSTRAINT: A SALE'S `arReceived` IS EXACTLY WHAT WAS ALLOCATED TO
-- IT, AND NEVER MORE THAN IT IS OWED.
--
-- Two rules in one function, because both are properties of the same sale and both
-- need the allocations summed:
--
--   `arReceived == SUM(allocations against this sale)`   — the cache cannot drift
--   `arReceived <= SUM(this sale's CREDIT tenders)`      — NO OVER-RECEIPT
--
-- `arReceived` is a CACHE of the first sum. It has to be, because the aging report
-- and the open-sales list read it per row and re-aggregating allocations per sale per
-- read is the wrong shape for the reports this module exists to serve. A cache that
-- can drift from its source is exactly the defect Task 3.1-FIX had to repair in
-- `stockValue`, so it is pinned to its source BY THE DATABASE rather than by the
-- discipline of whoever writes the next caller.
--
-- The second rule is the AR analogue of `billedQty <= receivedQty` (0018): you cannot
-- collect more than was put on account. It cannot be a row CHECK because the
-- receivable lives in `sale_tenders`, and it cannot be an immediate trigger because
-- the allocations and the `arReceived` update land in the same transaction — hence
-- deferred.
--
-- BOUND TO BOTH SIDES, per (h)'s lesson: on the allocations (which can make the sums
-- disagree by appearing) and on the sale (which can make them disagree by moving).
-- The sale binding is `AFTER UPDATE OF "arReceived"` specifically, so that the POS
-- sale path — the hottest write in the system — never evaluates it: a new sale has
-- `arReceived = 0` and no allocations, which satisfies both rules trivially, and a
-- void or a fiscal-status change does not mention the column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_sale_ar_matches_allocations() RETURNS trigger AS $$
DECLARE
  v_schema         text := TG_TABLE_SCHEMA;
  v_sale_id        text;
  v_number         text;
  v_received       bigint;
  v_allocated      bigint;
  v_credit_tenders bigint;
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN NULL;
    END IF;
    v_sale_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    v_sale_id := OLD."saleId";
  ELSE
    v_sale_id := NEW."saleId";
  END IF;

  EXECUTE format('SELECT "saleNumber", "arReceived" FROM %I.sales WHERE "id" = $1', v_schema)
    INTO v_number, v_received USING v_sale_id;

  IF v_number IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT COALESCE(SUM("amount"), 0) FROM %I.customer_receipt_allocations WHERE "saleId" = $1', v_schema)
    INTO v_allocated USING v_sale_id;

  IF v_received <> v_allocated THEN
    RAISE EXCEPTION
      'Sale % records % cents received but its receipt allocations total % cents (difference % cents). The received amount is a cache of the allocations and may never disagree with them.',
      v_number, v_received, v_allocated, (v_received - v_allocated);
  END IF;

  EXECUTE format(
    'SELECT COALESCE(SUM("amount"), 0) FROM %I.sale_tenders WHERE "saleId" = $1 AND "tenderType" = ''CREDIT''',
    v_schema)
    INTO v_credit_tenders USING v_sale_id;

  IF v_received > v_credit_tenders THEN
    RAISE EXCEPTION
      'Sale % : % cents received against a credit receivable of only % cents. A customer cannot pay more against a sale than it put on account.',
      v_number, v_received, v_credit_tenders;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER sale_ar_matches_allocations_on_allocation
  AFTER INSERT OR UPDATE OR DELETE ON customer_receipt_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_sale_ar_matches_allocations();

CREATE CONSTRAINT TRIGGER sale_ar_matches_allocations_on_sale
  AFTER UPDATE OF "arReceived" ON sales
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_sale_ar_matches_allocations();

-- ---------------------------------------------------------------------------
-- (j) DELIBERATELY NO CONSTRAINT tying `Customer.creditBalance` to
-- SUM over that customer's open credit sales.
--
-- It is the one aggregate in this module that is NOT database-enforced, and the
-- reason is specific rather than a matter of cost: `creditBalance` has TWO writers
-- (`sales.ts` raises it on a credit sale and lowers it on a void; `receivables.ts`
-- lowers it on a receipt), and a trigger tying it to the sales subledger would have
-- to fire on the POS sale path, re-aggregating every one of a customer's sales on the
-- hottest write in the system — the same considered trade-off recorded for the stock
-- aggregate in 0011, `PurchaseOrder.subtotal` in 0017 and `billedQty` in 0018.
--
-- What IS enforced locally: `creditBalance >= 0` (0006), and both halves of the
-- per-sale arithmetic above, which is what the aggregate is built from. The
-- customer-level agreement
--
--     SUM(Customer.creditBalance) == SUM over COMPLETED credit sales of
--                                    (SUM(credit tenders) - arReceived)
--
-- is an ACCEPTANCE CRITERION, verified on both tenants. Recorded here so it is read
-- as a decision rather than an oversight.
-- ---------------------------------------------------------------------------
