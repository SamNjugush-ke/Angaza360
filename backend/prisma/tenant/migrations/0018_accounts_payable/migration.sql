-- CreateEnum
CREATE TYPE "SupplierBillStatus" AS ENUM ('DRAFT', 'AWAITING_PAYMENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierPaymentMethod" AS ENUM ('CASH', 'BANK', 'MPESA');

-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "billedNet" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "billedQty" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "supplier_bills" (
    "id" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "poId" TEXT,
    "billDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "SupplierBillStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotalNet" BIGINT NOT NULL,
    "vatTotal" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,
    "amountPaid" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bill_lines" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "lineNet" BIGINT NOT NULL,
    "lineVat" BIGINT NOT NULL,
    "lineTotal" BIGINT NOT NULL,
    "purchaseOrderLineId" TEXT,
    "unitCostNet" BIGINT,
    "grniCleared" BIGINT,
    "expenseAccountCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" TEXT NOT NULL,
    "paymentNumber" INTEGER NOT NULL,
    "supplierId" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "method" "SupplierPaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_bills_status_idx" ON "supplier_bills"("status");

-- CreateIndex
CREATE INDEX "supplier_bills_supplierId_status_idx" ON "supplier_bills"("supplierId", "status");

-- CreateIndex
CREATE INDEX "supplier_bills_dueDate_idx" ON "supplier_bills"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bills_supplierId_billNumber_key" ON "supplier_bills"("supplierId", "billNumber");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_billId_idx" ON "supplier_bill_lines"("billId");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_purchaseOrderLineId_idx" ON "supplier_bill_lines"("purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_expenseAccountCode_idx" ON "supplier_bill_lines"("expenseAccountCode");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_paymentNumber_key" ON "supplier_payments"("paymentNumber");

-- CreateIndex
CREATE INDEX "supplier_payments_supplierId_idx" ON "supplier_payments"("supplierId");

-- CreateIndex
CREATE INDEX "supplier_payments_paymentDate_idx" ON "supplier_payments"("paymentDate");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_billId_idx" ON "supplier_payment_allocations"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_allocations_paymentId_billId_key" ON "supplier_payment_allocations"("paymentId", "billId");

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_billId_fkey" FOREIGN KEY ("billId") REFERENCES "supplier_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_expenseAccountCode_fkey" FOREIGN KEY ("expenseAccountCode") REFERENCES "accounts"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "supplier_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_billId_fkey" FOREIGN KEY ("billId") REFERENCES "supplier_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- NO BACKFILL, DELIBERATELY.
--
-- `billedQty` and `billedNet` default to 0 on every existing purchase order line,
-- and 0 IS THE TRUTH about them: supplier bills did not exist before this
-- migration, so nothing has been invoiced against any line. Writing anything else
-- would invent an invoicing history and would immediately break the three-way match
-- below.
--
-- The GRNI balance that already exists in a tenant's ledger is therefore correctly
-- described as received-not-yet-billed, and clearing it is a bill posted from here
-- on — not a retroactive adjustment. Same discipline as `locationId` on
-- stock_movements (0007), `lineCogs` on sale_lines (0012), `sellingLocationId` on
-- sales (0014), the offline dimensions (0015), `fiscalStatus` (0016) and the
-- procurement links (0017).
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
-- (a) NO NEW ACCOUNTS. Everything this module posts to already exists.
--
-- 2000 Accounts Payable and 1400 VAT Input (Recoverable) came with the chart in
-- Phase 2.1; 2050 GRNI and 5250 Purchase Price Variance were seeded by 0017
-- precisely so that this task would post to them rather than invent them. The
-- chart stays at 46 accounts, and the fact that accounts payable needed NO new
-- account is the evidence that 5.1 laid the foundation it claimed to.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- (b) PER-SCHEMA PAYMENT NUMBER SEQUENCE.
--
-- Same mechanism as `purchase_order_number_seq` and `goods_receipt_number_seq`
-- (0017) and `journal_entry_seq` (0003): monotonic and unique, NOT gap-free,
-- because a sequence is non-transactional and a payment whose transaction rolls
-- back burns its number. The gap-free row-locked counter used for KRA fiscal
-- invoice numbers (0016) is not warranted here — a missing internal payment number
-- has no regulatory meaning, two payments sharing one would be a reconciliation
-- defect.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE supplier_payment_number_seq START 1;

-- ---------------------------------------------------------------------------
-- (c) THE THREE-WAY MATCH, HELD BY THE DATABASE.
--
-- PO quantity >= received quantity was pinned by 0017
-- (`purchase_order_line_no_over_receipt`). This completes the match:
--
--       billedQty  <=  receivedQty  <=  orderedQty
--
-- You cannot be invoiced for more than arrived, and nothing arrived that was not
-- ordered. That is the whole classical three-way match (purchase order / goods
-- receipt / invoice), and it is a CHECK rather than a service rule because
-- over-billing is the exact shape of both supplier error and supplier fraud, and it
-- must be unrepresentable no matter which code path asks.
--
-- A supplier who invoices ahead of delivery is a DISPUTE, not a row: the bill is
-- held until the goods arrive, which is precisely the control this constraint
-- creates.
-- ---------------------------------------------------------------------------
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT purchase_order_line_no_over_billing
  CHECK ("billedQty" >= 0 AND "billedQty" <= "receivedQty");

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT purchase_order_line_billed_net_non_negative
  CHECK ("billedNet" >= 0);

-- ---------------------------------------------------------------------------
-- (d) EXTENDING THE 0017 PURCHASE-ORDER-LINE GUARD.
--
-- 0017 froze a line's terms once its order left DRAFT and allowed exactly ONE
-- field to move: `receivedQty`, and only UPWARD. `billedQty` and `billedNet` are
-- now the SECOND pair that may move after approval.
--
-- THEY ARE MUTABLE IN BOTH DIRECTIONS, AND THAT ASYMMETRY WITH `receivedQty` IS
-- THE POINT, not an oversight:
--
--   * `receivedQty` can never fall because a GOODS RECEIPT IS IMMUTABLE
--     (goods_receipts refuses UPDATE and DELETE). Nothing can un-receive goods,
--     so nothing may walk the quantity back.
--   * `billedQty` CAN fall, because a posted bill CAN be CANCELLED while it is
--     still unpaid. That cancellation posts a REVERSING journal entry — it does
--     not edit the original — and the goods it covered go back to being
--     received-not-yet-invoiced, which is exactly what a lower `billedQty` says.
--     Refusing the decrease would leave the PO line claiming an invoice that has
--     been reversed, and the goods could never be billed again.
--
-- What holds instead, and what each layer guarantees:
--   * ROW-LOCAL, by CHECK (section (c)): `0 <= billedQty <= receivedQty` and
--     `billedNet >= 0`. A cancellation can therefore never drive either negative,
--     and no path can ever bill more than arrived.
--   * AGGREGATE, by the service: `billedQty` equals the sum over the line's LIVE
--     (non-CANCELLED) bill lines. That is a cross-row aggregate on the write
--     path, so it is an acceptance criterion rather than a trigger — the same
--     considered trade-off recorded for `PurchaseOrder.subtotal` in 0017(n) and
--     for the stock aggregate in 0011.
--
-- The frozen set is UNCHANGED: productId, orderedQty, unitCost and lineNet are
-- still immutable once the order leaves DRAFT, and nothing else newly becomes
-- mutable. Only the function body is replaced; the trigger object
-- (`purchase_order_line_guard_iud`) binds by function name and is untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purchase_order_line_guard() RETURNS trigger AS $$
DECLARE
  po_status text;
  po_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('SELECT "status"::text, "poNumber" FROM %I.%I WHERE "id" = $1',
                   TG_TABLE_SCHEMA, 'purchase_orders')
      INTO po_status, po_number USING OLD."poId";
    -- A cascade from deleting the PO itself leaves no parent row to check, and a
    -- DRAFT PO is deletable with its lines.
    IF po_status IS NOT NULL AND po_status <> 'DRAFT' THEN
      RAISE EXCEPTION
        'Purchase order % is % : its lines cannot be removed. Only a DRAFT order may have lines added or removed.',
        po_number, po_status;
    END IF;
    RETURN OLD;
  END IF;

  EXECUTE format('SELECT "status"::text, "poNumber" FROM %I.%I WHERE "id" = $1',
                 TG_TABLE_SCHEMA, 'purchase_orders')
    INTO po_status, po_number USING NEW."poId";

  IF po_status IS NULL THEN
    RAISE EXCEPTION 'Purchase order line references purchase order %, which does not exist.',
      NEW."poId";
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF po_status <> 'DRAFT' THEN
      RAISE EXCEPTION
        'Purchase order % is % : no further lines may be added. Only a DRAFT order may have lines added or removed.',
        po_number, po_status;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. Identity never changes; commercial terms freeze with the header; the
  -- received and billed quantities are the fields a delivery and an invoice move.
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."poId" IS DISTINCT FROM OLD."poId" THEN
    RAISE EXCEPTION 'Purchase order line % cannot be re-pointed at another order.', OLD."id";
  END IF;

  IF po_status <> 'DRAFT' THEN
    IF NEW."productId"  IS DISTINCT FROM OLD."productId"
       OR NEW."orderedQty" IS DISTINCT FROM OLD."orderedQty"
       OR NEW."unitCost"   IS DISTINCT FROM OLD."unitCost"
       OR NEW."lineNet"    IS DISTINCT FROM OLD."lineNet"
    THEN
      RAISE EXCEPTION
        'Purchase order % is % : line terms (product, quantity, cost) are frozen. Only the received quantity (by receiving a delivery) and the billed quantity (by posting a supplier bill) may change.',
        po_number, po_status;
    END IF;
  END IF;

  -- Received quantity only ever goes UP. A goods receipt is an immutable posted
  -- fact (goods_receipts refuses UPDATE and DELETE), so walking receivedQty back
  -- would contradict a GRN that still exists and still accrued its value to GRNI.
  IF NEW."receivedQty" < OLD."receivedQty" THEN
    RAISE EXCEPTION
      'Purchase order % : received quantity cannot decrease (% -> %). A goods receipt is permanent; correct an over-receipt with a supplier credit, not by rewinding the line.',
      po_number, OLD."receivedQty", NEW."receivedQty";
  END IF;

  -- Billed quantity deliberately carries NO monotonicity rule: cancelling an
  -- unpaid bill reverses its entry and gives the quantity back. The row-local
  -- CHECKs (0 <= billedQty <= receivedQty, billedNet >= 0) and the service's
  -- aggregate rule are what hold it honest. See the note above this function.

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- (e) SUPPLIER BILL FIELD CONSTRAINTS.
-- ---------------------------------------------------------------------------

-- A supplier's invoice reference is the whole basis of the duplicate guard, so a
-- blank one would defeat it: every blank entry would collide with every other and
-- the FIRST blank invoice would block all the rest.
ALTER TABLE "supplier_bills" ADD CONSTRAINT supplier_bill_number_not_blank
  CHECK (btrim("billNumber") <> '');

-- MULTI-CURRENCY PLUG, pinned. Identical reasoning to purchase_order_currency_is_kes
-- (0017): the column exists so foreign currency is later new rows and a relaxed
-- CHECK, but a column that silently accepted 'USD' while every downstream figure
-- assumed shillings would be worse than no column at all.
ALTER TABLE "supplier_bills" ADD CONSTRAINT supplier_bill_currency_is_kes
  CHECK ("currency" = 'KES');

-- THE ARITHMETIC OF THE DOCUMENT. `total` is what the supplier is owed and what is
-- credited to 2000; it must be exactly net plus VAT. A header that did not add up
-- would make the bill's own journal entry unbalanceable, and the point of a CHECK
-- here is that the failure surfaces at the row rather than as a confusing imbalance
-- three statements later.
ALTER TABLE "supplier_bills" ADD CONSTRAINT supplier_bill_total_is_net_plus_vat
  CHECK ("total" = "subtotalNet" + "vatTotal");

ALTER TABLE "supplier_bills" ADD CONSTRAINT supplier_bill_amounts_non_negative
  CHECK ("subtotalNet" >= 0 AND "vatTotal" >= 0);

-- A zero invoice is not a document anybody owes against, and it would sit forever
-- in AWAITING_PAYMENT: no payment can settle it (a payment amount must be
-- positive), so it could never reach PAID and would age indefinitely in the
-- payables report as a liability of nothing.
ALTER TABLE "supplier_bills" ADD CONSTRAINT supplier_bill_total_positive
  CHECK ("total" > 0);

-- OVER-PAYMENT OF ONE INVOICE IS UNREPRESENTABLE. The service caps every
-- allocation at the remaining balance; this is the backstop behind it, and it is
-- what makes "unpaid balance" (`total - amountPaid`) a figure that can never go
-- negative and therefore never quietly offset another supplier's debt in the
-- aging report.
ALTER TABLE "supplier_bills" ADD CONSTRAINT supplier_bill_amount_paid_within_total
  CHECK ("amountPaid" >= 0 AND "amountPaid" <= "total");

-- Due before issued is not a term, it is a typo. Equal is legitimate: due on
-- receipt is the default when a supplier has no stated payment terms.
ALTER TABLE "supplier_bills" ADD CONSTRAINT supplier_bill_due_not_before_bill_date
  CHECK ("dueDate" >= "billDate");

-- WHICH STATUS EACH SETTLEMENT POSITION MUST CARRY. A half-written settlement —
-- PAID with a balance outstanding, PARTIALLY_PAID with nothing paid, CANCELLED
-- after money went out — cannot exist as a row. The state machine below governs
-- the TRANSITIONS; this governs the RESTING STATE, and both are needed: a trigger
-- cannot see a row inserted directly in its final shape.
ALTER TABLE "supplier_bills" ADD CONSTRAINT supplier_bill_status_matches_amount_paid
  CHECK (
    CASE "status"
      WHEN 'DRAFT'            THEN "amountPaid" = 0
      WHEN 'AWAITING_PAYMENT' THEN "amountPaid" = 0
      WHEN 'CANCELLED'        THEN "amountPaid" = 0
      WHEN 'PARTIALLY_PAID'   THEN "amountPaid" > 0 AND "amountPaid" < "total"
      WHEN 'PAID'             THEN "amountPaid" = "total"
    END
  );

-- ---------------------------------------------------------------------------
-- (f) THE SUPPLIER BILL STATE MACHINE AND ITS IMMUTABILITY, enforced by trigger.
--
-- DRAFT            -> AWAITING_PAYMENT | CANCELLED | DRAFT
-- AWAITING_PAYMENT -> PARTIALLY_PAID | PAID | CANCELLED
-- PARTIALLY_PAID   -> PARTIALLY_PAID | PAID
-- PAID             -> terminal
-- CANCELLED        -> terminal
--
-- WHY DRAFT IS A STATE AND NOT A FLAG: a keyed-in invoice that has not been checked
-- against the delivery is data entry, not a liability. A DRAFT has posted NOTHING,
-- which is what makes it freely editable; posting books the journal entry and
-- freezes the figures in the same transaction, so there is no window in which the
-- ledger and the document disagree.
--
-- CANCELLED IS ONLY REACHABLE WHILE NOTHING HAS BEEN PAID. Once money has gone
-- out, "this invoice never happened" is false, and the correction is a supplier
-- credit note — deliberately out of scope here, which is exactly why this trigger
-- must not be relaxed into a general-purpose edit path.
--
-- The IMMUTABILITY half is why this is a trigger and not a service rule: a posted
-- bill's figures ARE a journal entry that exists. Editing `total` after posting
-- would leave account 2000 carrying an amount no document supports, and the
-- reconciliation in the engineering ledger "Accounts Payable" would silently stop holding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION supplier_bill_guard() RETURNS trigger AS $$
DECLARE
  v_po_supplier text;
  v_po_number   integer;
BEGIN
  -- A PO-matched bill must belong to the SAME supplier as the order it matches.
  -- Otherwise this invoice would clear another supplier's GRNI accrual while
  -- crediting its own Accounts Payable: two suppliers' balances wrong, and the
  -- books still adding up, which is the worst kind of error.
  IF NEW."poId" IS NOT NULL THEN
    EXECUTE format('SELECT "supplierId", "poNumber" FROM %I.%I WHERE "id" = $1',
                   TG_TABLE_SCHEMA, 'purchase_orders')
      INTO v_po_supplier, v_po_number USING NEW."poId";
    IF v_po_supplier IS NULL THEN
      RAISE EXCEPTION 'Supplier bill references purchase order %, which does not exist.',
        NEW."poId";
    END IF;
    IF v_po_supplier <> NEW."supplierId" THEN
      RAISE EXCEPTION
        'Supplier bill % is from supplier %, but purchase order % belongs to supplier %. An invoice may only be matched to its own supplier''s order.',
        NEW."billNumber", NEW."supplierId", v_po_number, v_po_supplier;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A bill is BORN as a DRAFT. Inserting one already posted would skip the
    -- posting transaction entirely and leave Accounts Payable with no entry.
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION
        'Supplier bill % must be created as a DRAFT (got %). Posting is a separate operation because it is what books the journal entry.',
        NEW."billNumber", NEW."status";
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. Identity is frozen forever.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."supplierId"  IS DISTINCT FROM OLD."supplierId"
     OR NEW."billNumber"  IS DISTINCT FROM OLD."billNumber"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt"   IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'Supplier bill % : its identity (supplier, invoice number, who entered it, when) can never be changed. Re-pointing an invoice at another supplier would move a liability between creditors.',
      OLD."billNumber";
  END IF;

  -- Every financial field, the PO match and the currency freeze the moment the
  -- bill leaves DRAFT, because from that moment a journal entry describes them.
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."poId"        IS DISTINCT FROM OLD."poId"
       OR NEW."billDate"    IS DISTINCT FROM OLD."billDate"
       OR NEW."dueDate"     IS DISTINCT FROM OLD."dueDate"
       OR NEW."subtotalNet" IS DISTINCT FROM OLD."subtotalNet"
       OR NEW."vatTotal"    IS DISTINCT FROM OLD."vatTotal"
       OR NEW."total"       IS DISTINCT FROM OLD."total"
       OR NEW."currency"    IS DISTINCT FROM OLD."currency"
       OR NEW."notes"       IS DISTINCT FROM OLD."notes"
    THEN
      RAISE EXCEPTION
        'Supplier bill % is % : it has been posted to the ledger and its figures are frozen. Only the payment status and the amount paid may change. Correct a mis-posted bill with a supplier credit note, never by editing it.',
        OLD."billNumber", OLD."status";
    END IF;
  END IF;

  -- The amount paid only ever rises. A posted payment is settled: money left.
  IF NEW."amountPaid" < OLD."amountPaid" THEN
    RAISE EXCEPTION
      'Supplier bill % : the amount paid cannot decrease (% -> % cents). A supplier payment is an immutable posted fact.',
      OLD."billNumber", OLD."amountPaid", NEW."amountPaid";
  END IF;

  -- THE STATE MACHINE.
  IF NEW."status" <> OLD."status" THEN
    IF OLD."status" = 'DRAFT' THEN
      IF NEW."status" NOT IN ('AWAITING_PAYMENT', 'CANCELLED') THEN
        RAISE EXCEPTION
          'Supplier bill % : a DRAFT may only be posted (AWAITING_PAYMENT) or cancelled (got %).',
          OLD."billNumber", NEW."status";
      END IF;
    ELSIF OLD."status" = 'AWAITING_PAYMENT' THEN
      IF NEW."status" NOT IN ('PARTIALLY_PAID', 'PAID', 'CANCELLED') THEN
        RAISE EXCEPTION
          'Supplier bill % : a posted bill awaiting payment may only become PARTIALLY_PAID, PAID or CANCELLED (got %).',
          OLD."billNumber", NEW."status";
      END IF;
    ELSIF OLD."status" = 'PARTIALLY_PAID' THEN
      IF NEW."status" <> 'PAID' THEN
        RAISE EXCEPTION
          'Supplier bill % : a partly paid bill may only become PAID (got %). It can no longer be cancelled, because money has already gone out — that correction is a supplier credit note.',
          OLD."billNumber", NEW."status";
      END IF;
    ELSE
      RAISE EXCEPTION
        'Supplier bill % is % , which is terminal. No further transition is possible (attempted %).',
        OLD."billNumber", OLD."status", NEW."status";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_bill_guard_iu
  BEFORE INSERT OR UPDATE ON supplier_bills
  FOR EACH ROW EXECUTE FUNCTION supplier_bill_guard();

-- A POSTED BILL CANNOT BE DELETED. Its journal entry is immutable and would be
-- orphaned, 2000 would carry a credit with nothing behind it, and the GRNI it
-- cleared would never come back. A DRAFT has posted nothing and may be discarded.
CREATE OR REPLACE FUNCTION supplier_bill_no_delete_once_posted() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION
      'Supplier bill % is % and cannot be deleted: its journal entry would be orphaned and the GRNI it cleared would be lost. Cancel an unpaid bill instead; correct a paid one with a supplier credit note.',
      OLD."billNumber", OLD."status";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_bill_no_delete_posted
  BEFORE DELETE ON supplier_bills
  FOR EACH ROW EXECUTE FUNCTION supplier_bill_no_delete_once_posted();

-- ---------------------------------------------------------------------------
-- (g) SUPPLIER BILL LINE CONSTRAINTS.
-- ---------------------------------------------------------------------------

ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_description_not_blank
  CHECK (btrim("description") <> '');

ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_quantity_positive
  CHECK ("quantity" > 0);

-- A RATE, not money. Bounded 0-100 inclusive: a zero-rated or exempt line is
-- 0.00, which is a real VAT treatment and must stay expressible.
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_vat_rate_is_a_percentage
  CHECK ("vatRate" >= 0 AND "vatRate" <= 100);

ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_amounts_non_negative
  CHECK ("lineNet" >= 0 AND "lineVat" >= 0);

ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_total_is_net_plus_vat
  CHECK ("lineTotal" = "lineNet" + "lineVat");

-- THE DISCRIMINATOR. Exactly one kind, never both, never neither. A line with both
-- references would try to clear GRNI AND charge an expense for the same amount
-- (double-counting the cost); a line with neither has no account to debit at all,
-- so its share of the invoice would simply vanish and the entry could not balance.
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_kind_is_exclusive
  CHECK (("purchaseOrderLineId" IS NULL) <> ("expenseAccountCode" IS NULL));

-- An invoiced unit cost belongs to a PO match and only to a PO match: it is the
-- figure compared against the agreed `unitCost` to produce the price variance.
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_po_match_carries_unit_cost
  CHECK (("purchaseOrderLineId" IS NULL) = ("unitCostNet" IS NULL));

ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_unit_cost_non_negative
  CHECK ("unitCostNet" IS NULL OR "unitCostNet" >= 0);

-- ONLY A PO MATCH CLEARS GRNI. An expense line has no accrual behind it — nothing
-- was received — so debiting 2050 for one would remove a liability that was never
-- raised and leave GRNI understating what is genuinely received-not-invoiced.
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_only_po_match_clears_grni
  CHECK ("grniCleared" IS NULL OR "purchaseOrderLineId" IS NOT NULL);

ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_grni_cleared_non_negative
  CHECK ("grniCleared" IS NULL OR "grniCleared" >= 0);

-- THE CONTROL ACCOUNTS THIS MODULE MAY NOT CHARGE AS AN EXPENSE.
--
--   1200 Inventory — moves ONLY through src/services/inventory.ts. A bill line
--        debiting it would break `sum(Product.stockValue) = GL(1200)` on the spot
--        (the engineering ledger "Single-Writer Service Boundaries").
--   2000 Accounts Payable — the credit side of this very entry. Debiting it as an
--        expense would net the invoice against itself.
--   2050 GRNI — cleared only by the PO-match arithmetic, never by a free-text
--        account code.
--   1400 VAT Input — recognised only from a line's `lineVat`, so that the VAT
--        recoverable always equals the VAT the invoices actually charged.
--   5250 Purchase Price Variance — computed, never keyed. A hand-entered variance
--        would make 5250 stop meaning "PO price minus invoiced price".
--
-- The FK to accounts(code) guarantees the account EXISTS; this CHECK guarantees it
-- is not one of ours; the trigger below guarantees it is of a chargeable class.
-- Three layers, three different mistakes.
-- ---------------------------------------------------------------------------
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT supplier_bill_line_expense_account_is_not_a_control_account
  CHECK ("expenseAccountCode" IS NULL
         OR "expenseAccountCode" NOT IN ('1200', '2000', '2050', '1400', '5250'));

-- ---------------------------------------------------------------------------
-- (h) THE BILL LINE GUARD: a frozen line set, a chargeable expense account, and a
-- PO match that belongs to this bill's own order.
--
-- WHY THE LINE SET FREEZES WITH THE BILL rather than per line: the lines ARE the
-- journal entry. Adding one to a posted bill would charge an account with nothing
-- crediting it; changing one would make `subtotalNet` disagree with its own lines
-- while 2000 still carried the original figure. Same discipline, same reasoning, as
-- `purchase_order_line_guard` (0017).
--
-- `grniCleared` IS WRITTEN WHILE THE BILL IS STILL A DRAFT — the posting
-- transaction stamps the lines and THEN flips the status, in that order, so this
-- guard sees an ordinary DRAFT edit. Keep that order; reversing it would make the
-- posting fail against the very rule that protects it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION supplier_bill_line_guard() RETURNS trigger AS $$
DECLARE
  v_bill_status text;
  v_bill_number text;
  v_bill_po     text;
  v_po_of_line  text;
  v_class       text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('SELECT "status"::text, "billNumber" FROM %I.%I WHERE "id" = $1',
                   TG_TABLE_SCHEMA, 'supplier_bills')
      INTO v_bill_status, v_bill_number USING OLD."billId";
    -- A cascade from deleting the bill itself leaves no parent row to check, and a
    -- DRAFT bill is discardable with its lines.
    IF v_bill_status IS NOT NULL AND v_bill_status <> 'DRAFT' THEN
      RAISE EXCEPTION
        'Supplier bill % is % : its lines cannot be removed. Only a DRAFT bill may have lines added or removed.',
        v_bill_number, v_bill_status;
    END IF;
    RETURN OLD;
  END IF;

  EXECUTE format('SELECT "status"::text, "billNumber", "poId" FROM %I.%I WHERE "id" = $1',
                 TG_TABLE_SCHEMA, 'supplier_bills')
    INTO v_bill_status, v_bill_number, v_bill_po USING NEW."billId";

  IF v_bill_status IS NULL THEN
    RAISE EXCEPTION 'Supplier bill line references bill %, which does not exist.', NEW."billId";
  END IF;

  IF v_bill_status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'Supplier bill % is % : its lines are frozen, because they ARE its journal entry. Only a DRAFT bill may have its lines changed.',
      v_bill_number, v_bill_status;
  END IF;

  -- A PO MATCH MUST MATCH THIS BILL'S OWN ORDER. Clearing GRNI raised by a
  -- different purchase order would move a liability this invoice has nothing to do
  -- with, and would leave the other order looking invoiced when it is not.
  IF NEW."purchaseOrderLineId" IS NOT NULL THEN
    IF v_bill_po IS NULL THEN
      RAISE EXCEPTION
        'Supplier bill % has no purchase order, so it cannot carry a PO-matched line. Set the bill''s purchase order, or enter the line as an expense.',
        v_bill_number;
    END IF;
    EXECUTE format('SELECT "poId" FROM %I.%I WHERE "id" = $1',
                   TG_TABLE_SCHEMA, 'purchase_order_lines')
      INTO v_po_of_line USING NEW."purchaseOrderLineId";
    IF v_po_of_line IS NULL THEN
      RAISE EXCEPTION 'Supplier bill % references purchase order line %, which does not exist.',
        v_bill_number, NEW."purchaseOrderLineId";
    END IF;
    IF v_po_of_line <> v_bill_po THEN
      RAISE EXCEPTION
        'Supplier bill % is matched to one purchase order but line % belongs to another. A bill may only clear GRNI raised by its own order.',
        v_bill_number, NEW."purchaseOrderLineId";
    END IF;
  END IF;

  -- A CHARGEABLE ACCOUNT CLASS. EXPENSE and COST_OF_SALES are the ordinary
  -- destinations for a supplier invoice; ASSET is permitted because a capital
  -- purchase (equipment, a vehicle, a deposit) arrives on a supplier invoice like
  -- anything else and belongs on the balance sheet, not in the P&L. LIABILITY,
  -- EQUITY and REVENUE are refused: charging a cost to one of those would mis-state
  -- the financial statements in a way no report would flag, because the entry would
  -- still balance perfectly.
  IF NEW."expenseAccountCode" IS NOT NULL THEN
    EXECUTE format('SELECT "accountClass"::text FROM %I.%I WHERE "code" = $1',
                   TG_TABLE_SCHEMA, 'accounts')
      INTO v_class USING NEW."expenseAccountCode";
    IF v_class IS NULL THEN
      RAISE EXCEPTION 'Supplier bill % : account % does not exist.',
        v_bill_number, NEW."expenseAccountCode";
    END IF;
    IF v_class NOT IN ('EXPENSE', 'COST_OF_SALES', 'ASSET') THEN
      RAISE EXCEPTION
        'Supplier bill % : account % is a % account and cannot be charged by a supplier bill. Only EXPENSE, COST_OF_SALES and ASSET accounts may be.',
        v_bill_number, NEW."expenseAccountCode", v_class;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_bill_line_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_bill_lines
  FOR EACH ROW EXECUTE FUNCTION supplier_bill_line_guard();

-- ---------------------------------------------------------------------------
-- (i) SUPPLIER PAYMENT: FIELD CONSTRAINTS AND TOTAL IMMUTABILITY.
--
-- Template: goods_receipt_immutable (0017), etims_invoice_no_delete (0016), the
-- stock-movement immutability trigger (0005). A payment records that money LEFT
-- THE BUSINESS. Editing it would leave its journal entry describing a disbursement
-- that no longer claims to have happened; deleting it would orphan that entry and
-- silently un-pay every bill its allocations settled.
--
-- There is deliberately no status column and no reversal path: a payment that
-- bounced or was sent in error is corrected by a separate receipt-from-supplier
-- document, which keeps both the payment and the correction visible. That document
-- is out of scope, and THIS TRIGGER IS WHAT MAKES THAT DEFERRAL SAFE rather than a
-- gap — nobody can quietly delete the problem instead.
-- ---------------------------------------------------------------------------
ALTER TABLE "supplier_payments" ADD CONSTRAINT supplier_payment_number_positive
  CHECK ("paymentNumber" > 0);

-- Strictly positive. A negative payment would be a refund FROM the supplier, which
-- is a different document with a different ledger effect (Dr cash / Cr AP), and
-- expressing it as a negative disbursement would make every cash-out report wrong.
ALTER TABLE "supplier_payments" ADD CONSTRAINT supplier_payment_amount_positive
  CHECK ("amount" > 0);

CREATE OR REPLACE FUNCTION supplier_payment_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Supplier payment PAY-% is immutable: it records that money left the business and it has a journal entry behind it. Correct an erroneous payment with a separate document, never by editing the payment.',
      OLD."paymentNumber";
  END IF;
  RAISE EXCEPTION
    'Supplier payment PAY-% cannot be deleted: its journal entry would be orphaned and every bill its allocations settled would silently become unpaid.',
    OLD."paymentNumber";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_payment_no_update
  BEFORE UPDATE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_immutable();

CREATE TRIGGER supplier_payment_no_delete
  BEFORE DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_immutable();

-- ---------------------------------------------------------------------------
-- (j) ALLOCATIONS ARE WRITE-ONCE.
--
-- An allocation says "this much of that payment settled this invoice". It is
-- written in the payment's own transaction and never again: changing one would move
-- settlement between invoices without moving any money, which is how one supplier
-- ends up looking paid and another chasing a balance we think we cleared.
-- ---------------------------------------------------------------------------
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT supplier_payment_allocation_amount_positive
  CHECK ("amount" > 0);

CREATE OR REPLACE FUNCTION supplier_payment_allocation_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Payment allocation % is write-once: it is part of a posted payment. Re-allocating settlement between invoices without moving money would falsify both suppliers'' balances.',
      OLD."id";
  END IF;
  RAISE EXCEPTION
    'Payment allocation % cannot be deleted: the bill it settled would silently become unpaid while the payment that settled it still exists.',
    OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_payment_allocation_no_update
  BEFORE UPDATE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocation_immutable();

CREATE TRIGGER supplier_payment_allocation_no_delete
  BEFORE DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocation_immutable();

-- ---------------------------------------------------------------------------
-- (k) DEFERRED CONSTRAINT: EVERY SHILLING OF A PAYMENT IS ALLOCATED.
--
-- `SUM(allocations.amount) = payment.amount`, checked at COMMIT. This is the exact
-- mechanism `journal_balance_check` uses for debits = credits (0003, made
-- schema-safe in 0004), and for the same reason: the rows arrive in several
-- statements, so the rule can only be evaluated once they are all present, and
-- DEFERRABLE INITIALLY DEFERRED is what lets a correct multi-statement write
-- succeed while any transaction that would leave an inconsistency fails atomically.
--
-- WHY IT IS A DATABASE CONSTRAINT AND NOT JUST A SERVICE RULE: an under-allocated
-- payment is cash that left the business with no invoice reduced — Accounts Payable
-- stays overstated and the aging report keeps chasing a paid supplier. An
-- over-allocated one pays bills with money that never left. The engineering ledger is explicit
-- that the application check is ergonomics and the constraint is the guarantee.
--
-- There is no on-account/prepayment balance in this build, which is precisely what
-- makes this constraint expressible as equality. If prepayments are ever added, the
-- rule becomes "allocations + prepayment = amount" — a change to this function, not
-- a migration across settled payments.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_payment_fully_allocated() RETURNS trigger AS $$
DECLARE
  v_schema     text := TG_TABLE_SCHEMA;
  v_payment_id text;
  v_number     integer;
  v_amount     bigint;
  v_allocated  bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_payment_id := OLD."paymentId";
  ELSE
    v_payment_id := NEW."paymentId";
  END IF;

  EXECUTE format('SELECT "paymentNumber", "amount" FROM %I.supplier_payments WHERE "id" = $1', v_schema)
    INTO v_number, v_amount USING v_payment_id;

  -- Parent payment gone: nothing to validate (it cannot happen while the
  -- immutability trigger above stands, but the guard costs nothing).
  IF v_number IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT COALESCE(SUM("amount"), 0) FROM %I.supplier_payment_allocations WHERE "paymentId" = $1', v_schema)
    INTO v_allocated USING v_payment_id;

  IF v_allocated <> v_amount THEN
    RAISE EXCEPTION
      'Supplier payment PAY-% is % cents but % cents are allocated to invoices (difference % cents). Every shilling of a payment must be pointed at a bill: there is no on-account supplier balance.',
      v_number, v_amount, v_allocated, (v_amount - v_allocated);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER payment_fully_allocated_check
  AFTER INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payment_fully_allocated();

-- ---------------------------------------------------------------------------
-- (l) DEFERRED CONSTRAINT: A BILL'S `amountPaid` IS EXACTLY WHAT WAS ALLOCATED TO IT.
--
-- This is THE constraint that makes the AP reconciliation in the engineering ledger hold:
--
--     SUM(bill.total - bill.amountPaid) over unpaid bills  ==  the aging report
--                                                          ==  the AP movement in GL 2000
--
-- `amountPaid` is a cached aggregate — it has to be, because the aging report reads
-- it on every row and re-aggregating allocations per bill per read is the wrong
-- shape for the hottest report in the module. A cache that can drift from its
-- source is exactly the defect Task 3.1-FIX had to repair in `stockValue`, so this
-- cache is pinned to its source BY THE DATABASE rather than by the discipline of
-- whoever writes the next caller.
--
-- It is attached to BOTH sides deliberately: a trigger only on allocations would
-- miss an `amountPaid` moved with no allocation behind it, which is the easier of
-- the two mistakes to make.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_bill_paid_matches_allocations() RETURNS trigger AS $$
DECLARE
  v_schema    text := TG_TABLE_SCHEMA;
  v_bill_id   text;
  v_number    text;
  v_paid      bigint;
  v_allocated bigint;
BEGIN
  IF TG_TABLE_NAME = 'supplier_bills' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN NULL;
    END IF;
    v_bill_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    v_bill_id := OLD."billId";
  ELSE
    v_bill_id := NEW."billId";
  END IF;

  EXECUTE format('SELECT "billNumber", "amountPaid" FROM %I.supplier_bills WHERE "id" = $1', v_schema)
    INTO v_number, v_paid USING v_bill_id;

  -- Parent bill gone (a discarded DRAFT, which can carry no allocations): nothing
  -- to validate.
  IF v_number IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT COALESCE(SUM("amount"), 0) FROM %I.supplier_payment_allocations WHERE "billId" = $1', v_schema)
    INTO v_allocated USING v_bill_id;

  IF v_paid <> v_allocated THEN
    RAISE EXCEPTION
      'Supplier bill % records % cents paid but its payment allocations total % cents (difference % cents). The paid amount is a cache of the allocations and may never disagree with them.',
      v_number, v_paid, v_allocated, (v_paid - v_allocated);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER bill_paid_matches_allocations_on_allocation
  AFTER INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_bill_paid_matches_allocations();

CREATE CONSTRAINT TRIGGER bill_paid_matches_allocations_on_bill
  AFTER INSERT OR UPDATE ON supplier_bills
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_bill_paid_matches_allocations();

-- ---------------------------------------------------------------------------
-- (m) DELIBERATELY NO CONSTRAINT tying `SupplierBill.subtotalNet` / `vatTotal` to
-- SUM over its lines, and none tying `PurchaseOrderLine.billedQty` / `billedNet`
-- to SUM over the bill lines that reference it.
--
-- Both are cross-row aggregates on the write path. This is the SAME considered
-- trade-off recorded for the stock aggregate invariant in 0011 and for
-- `PurchaseOrder.subtotal` in 0017: the database enforces what is cheap and local
-- (every per-row CHECK above, the discriminator, the three-way-match cap, the state
-- machine, the frozen line set), one service writes both sides inside ONE
-- transaction, and the aggregate agreement is an acceptance criterion.
--
-- The two aggregates that ARE enforced — (k) and (l) — earn their cost because they
-- are the ones that keep CASH and the CREDITOR LEDGER honest, and because they fire
-- once at COMMIT rather than on every line of every document. Recorded here so the
-- asymmetry is read as a decision rather than an oversight.
-- ---------------------------------------------------------------------------
