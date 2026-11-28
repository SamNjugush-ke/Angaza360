-- CreateEnum
CREATE TYPE "TenantTaxRegime" AS ENUM ('VAT_REGISTERED', 'TURNOVER_TAX', 'EXEMPT');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "goodsReceiptId" TEXT,
ADD COLUMN     "purchaseOrderLineId" TEXT;

-- CreateTable
CREATE TABLE "business_profile" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "taxRegime" "TenantTaxRegime" NOT NULL DEFAULT 'TURNOVER_TAX',
    "isVatRegistered" BOOLEAN NOT NULL DEFAULT false,
    "defaultVatRate" DECIMAL(5,2) NOT NULL DEFAULT 16.00,
    "kraPin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "poNumber" INTEGER NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderDate" TIMESTAMP(3) NOT NULL,
    "expectedDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderedQty" DECIMAL(14,3) NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "lineNet" BIGINT NOT NULL,
    "receivedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" TEXT NOT NULL,
    "grnNumber" INTEGER NOT NULL,
    "poId" TEXT NOT NULL,
    "receivingLocationId" TEXT NOT NULL,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_poNumber_key" ON "purchase_orders"("poNumber");

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status");

-- CreateIndex
CREATE INDEX "purchase_orders_supplierId_status_idx" ON "purchase_orders"("supplierId", "status");

-- CreateIndex
CREATE INDEX "purchase_order_lines_productId_idx" ON "purchase_order_lines"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_poId_productId_key" ON "purchase_order_lines"("poId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_grnNumber_key" ON "goods_receipts"("grnNumber");

-- CreateIndex
CREATE INDEX "goods_receipts_poId_idx" ON "goods_receipts"("poId");

-- CreateIndex
CREATE INDEX "goods_receipts_receivedAt_idx" ON "goods_receipts"("receivedAt");

-- CreateIndex
CREATE INDEX "stock_movements_goodsReceiptId_idx" ON "stock_movements"("goodsReceiptId");

-- CreateIndex
CREATE INDEX "stock_movements_purchaseOrderLineId_idx" ON "stock_movements"("purchaseOrderLineId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "goods_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_receivingLocationId_fkey" FOREIGN KEY ("receivingLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- NO BACKFILL OF stock_movements, DELIBERATELY.
--
-- `goodsReceiptId` and `purchaseOrderLineId` are NULL on every existing row, and
-- NULL is the TRUTHFUL statement about them: purchase orders did not exist, so no
-- movement that exists today came from one. Writing anything into them would
-- invent a procurement history. Same NULL-means-default pattern as `locationId`
-- on stock_movements (0007), `lineCogs` on sale_lines (0012), `sellingLocationId`
-- on sales (0014), the offline dimensions (0015) and `fiscalStatus` (0016).
--
-- stock_movements is IMMUTABLE (0005 refuses UPDATE and DELETE), so a backfill was
-- never available here even if it had been desirable — which is exactly why the
-- NULL-means-default rule exists.
-- ===========================================================================

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) THE TWO NEW ACCOUNTS, seeded into EXISTING tenant schemas.
--
-- Provisioning seeds the whole chart from chart-of-accounts.ts for a NEW tenant,
-- so this block exists only for tenants that already traded before 5.1. Keyed on
-- `code` with ON CONFLICT DO NOTHING, so it is a zero-op on a schema that already
-- has them — and so running it after provisioning has already seeded the chart
-- cannot double-insert.
--
-- The enum casts are unqualified: this migration runs with the tenant schema on
-- the search_path, which is where AccountClass and NormalBalance live.
--
-- 2050 GRNI is a CLEARING account and the rules governing it are not decoration:
-- only a goods receipt credits it, and only a supplier bill (Task 5.2) debits it.
-- No sale, void, transfer, write-off, adjustment or payment may touch it.
-- ---------------------------------------------------------------------------
INSERT INTO "accounts"
  ("id", "code", "name", "accountClass", "normalBalance", "description",
   "isSystem", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), '2050', 'Goods Received Not Invoiced (GRNI)',
   'LIABILITY'::"AccountClass", 'CREDIT'::"NormalBalance",
   'Received-not-invoiced clearing. Credited when goods arrive against a purchase order (the GRN accrues what is owed before the supplier''s tax invoice exists); cleared to 2000 Accounts Payable when the bill is booked (Task 5.2). NEVER a destination for a sale, a payment, a transfer, a write-off or an adjustment — only a goods receipt puts value here and only a supplier bill takes it out. Task 5.1.',
   true, true, now(), now())
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "accounts"
  ("id", "code", "name", "accountClass", "normalBalance", "description",
   "isSystem", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), '5250', 'Purchase Price Variance',
   'COST_OF_SALES'::"AccountClass", 'DEBIT'::"NormalBalance",
   'The difference between the cost a goods receipt accrued (the PO''s unit cost) and the net cost the supplier actually invoiced. Posted when a bill is booked against a GRN (Task 5.2), so that inventory keeps the cost it was received at and the discrepancy is visible in cost of sales rather than silently restating stock. Task 5.1 creates the account; 5.2 posts to it.',
   true, true, now(), now())
ON CONFLICT ("code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- (b) PER-SCHEMA NUMBER SEQUENCES for POs and GRNs.
--
-- The same mechanism journal entry numbers have used since migration 0003
-- (`journal_entry_seq`): a plain Postgres sequence, per tenant schema, read with
-- nextval.
--
-- MONOTONIC AND UNIQUE, BUT NOT GAP-FREE, and that is the right trade. A sequence
-- is non-transactional, so a PO whose transaction rolls back burns its number.
-- The alternative — a counter row locked FOR UPDATE, as the eTIMS invoice counter
-- does — is gap-free but serialises every creation on one row, and it is only
-- worth that cost where a gap has a REGULATORY meaning. For a KRA fiscal invoice
-- number it does (a gap invites a revenue-authority question); for an internal
-- purchase-order number it does not. Two POs sharing a number would be a real
-- problem; PO 7 not existing is not.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE purchase_order_number_seq START 1;
CREATE SEQUENCE goods_receipt_number_seq START 1;

-- ---------------------------------------------------------------------------
-- (c) BUSINESS PROFILE: EXACTLY ONE ROW, FOREVER.
--
-- The primary key plus this CHECK is the whole guarantee. With `id` pinned to the
-- literal 'singleton', a second row cannot be inserted under any id — not by a
-- service bug, not by raw psql, not by a future migration that forgets. A unique
-- partial index would have achieved the same, but this way the ERROR a second
-- insert produces names the rule instead of naming an index.
-- ---------------------------------------------------------------------------
ALTER TABLE "business_profile" ADD CONSTRAINT business_profile_is_singleton
  CHECK ("id" = 'singleton');

-- (d) taxRegime AND isVatRegistered CAN NEVER DISAGREE.
--
-- isVatRegistered is DERIVED from taxRegime; it is stored because it is what the
-- posting path branches on, and storing a derived value is only safe when the
-- database guarantees it matches its source. This is that guarantee.
--
-- Getting this pair wrong would be expensive in a specific way: a tenant marked
-- VAT-registered while actually on turnover tax would recover input VAT it is not
-- entitled to, understate inventory cost, and under-declare to KRA — an error
-- discovered at audit, not at the till.
ALTER TABLE "business_profile" ADD CONSTRAINT business_profile_vat_flag_matches_regime
  CHECK (
    ("taxRegime" = 'VAT_REGISTERED' AND "isVatRegistered" = true)
    OR
    ("taxRegime" <> 'VAT_REGISTERED' AND "isVatRegistered" = false)
  );

-- (e) The VAT rate is a percentage, not money. 0-100 inclusive: a zero-rated
-- business is legitimate, a negative or >100% rate is not a finance-act figure.
ALTER TABLE "business_profile" ADD CONSTRAINT business_profile_vat_rate_is_a_percentage
  CHECK ("defaultVatRate" >= 0 AND "defaultVatRate" <= 100);

-- ---------------------------------------------------------------------------
-- (f) SEED THE SINGLETON for every EXISTING tenant, with the NON-REGISTERED
-- defaults.
--
-- TURNOVER_TAX / isVatRegistered = false is chosen to PRESERVE TODAY'S POSTING
-- BEHAVIOUR EXACTLY. Every purchase receipt booked before this table existed
-- debited 1200 with the full cost supplied and credited Accounts Payable with the
-- same figure, recognising no input VAT — which is precisely what a
-- non-registered tenant does. So the default is not a guess about the business, it
-- is the honest description of how its existing ledger was built, and NO
-- HISTORICAL ENTRY IS RE-POSTED.
--
-- A tenant that IS VAT-registered says so through PUT /v1/settings/business-
-- profile, and the change applies to receipts from that moment on. It is
-- deliberately NOT retroactive: restating the cost of stock already received, sold
-- and reported would rewrite settled financial records.
--
-- ON CONFLICT DO NOTHING keyed on the pinned primary key, so this is a zero-op on
-- re-run.
-- ---------------------------------------------------------------------------
INSERT INTO "business_profile" ("id", "taxRegime", "isVatRegistered", "defaultVatRate", "createdAt", "updatedAt")
VALUES ('singleton', 'TURNOVER_TAX'::"TenantTaxRegime", false, 16.00, now(), now())
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- (g) PURCHASE ORDER FIELD CONSTRAINTS.
-- ---------------------------------------------------------------------------

-- A PO number is a positive integer. Zero or negative would mean the allocator
-- read something other than the sequence.
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_order_number_positive
  CHECK ("poNumber" > 0);

-- MULTI-CURRENCY IS DEFERRED, AND THE CHECK IS WHAT MAKES THE DEFERRAL HONEST.
-- The column exists so enabling foreign currency later is additive, but until the
-- FX work is done every downstream figure — subtotal, GRNI accrual, inventory
-- cost — assumes shillings. A column that silently accepted 'USD' would produce a
-- ledger that looks right and is wrong by a factor of 130.
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_order_currency_is_kes
  CHECK ("currency" = 'KES');

-- A PO's committed value is never negative.
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_order_subtotal_non_negative
  CHECK ("subtotal" >= 0);

-- APPROVAL IS RECORDED COMPLETELY OR NOT AT ALL: who approved it and when, both or
-- neither. A PO approved by nobody, or at no time, cannot be audited.
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_order_approval_recorded_together
  CHECK (("approvedById" IS NULL) = ("approvedAt" IS NULL));

-- A DRAFT HAS NOT BEEN APPROVED. Otherwise a row could claim an approver while
-- still sitting in the editable state the approval was supposed to end.
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_order_draft_is_unapproved
  CHECK ("status" <> 'DRAFT' OR "approvedById" IS NULL);

-- ---------------------------------------------------------------------------
-- (h) PURCHASE ORDER LINE CONSTRAINTS — including the OVER-RECEIPT GUARD.
-- ---------------------------------------------------------------------------

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT purchase_order_line_ordered_qty_positive
  CHECK ("orderedQty" > 0);

-- A cost of zero is legitimate (a free sample, a promotional unit — the same
-- reasoning as the zero-cost receipt the valuation rules already permit), a
-- negative one is not.
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT purchase_order_line_unit_cost_non_negative
  CHECK ("unitCost" >= 0);

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT purchase_order_line_net_non_negative
  CHECK ("lineNet" >= 0);

-- YOU CANNOT RECEIVE MORE THAN YOU ORDERED.
--
-- The service refuses an over-receipt with a message naming the line and the
-- outstanding quantity; THIS is the guarantee. Without it a double-submitted
-- receipt would accrue a liability to GRNI for goods never ordered and inflate
-- inventory — and because a GRN is immutable, there would be no way to take it
-- back except a compensating entry. Both exist on purpose: the application check
-- is ergonomics, the constraint is the invariant (the engineering ledger "Working Practices").
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT purchase_order_line_no_over_receipt
  CHECK ("receivedQty" >= 0 AND "receivedQty" <= "orderedQty");

-- ---------------------------------------------------------------------------
-- (i) THE PURCHASE ORDER STATE MACHINE, enforced by trigger.
--
-- Template: the allocation_request_guard in migration 0013. The service returns
-- the clean 409; this trigger is the guarantee, and it is what makes "a PO may
-- only be received when APPROVED or PARTIALLY_RECEIVED" true rather than merely
-- intended.
--
-- THE PERMITTED TRANSITIONS, and why each exists:
--   DRAFT              -> APPROVED | CANCELLED
--   APPROVED           -> PARTIALLY_RECEIVED | RECEIVED | CANCELLED
--   PARTIALLY_RECEIVED -> RECEIVED | CLOSED
--   RECEIVED           -> CLOSED
--   CLOSED, CANCELLED  -> TERMINAL
--
-- Note what is ABSENT: there is no path out of PARTIALLY_RECEIVED to CANCELLED.
-- Once goods have arrived and value has been accrued to GRNI, the order DID
-- happen; cancelling it would orphan a liability the supplier will still invoice.
-- Such an order is CLOSED short instead, which says "we are finished with it"
-- without claiming it never occurred.
--
-- IMMUTABILITY, the second half of this trigger: once a PO leaves DRAFT its
-- commercial terms are frozen — supplier, dates, currency, subtotal, the creator.
-- A DRAFT is freely editable, because nothing has been committed to anyone. After
-- approval the supplier has a copy, and editing our side of a shared agreement
-- without them is not an edit, it is a discrepancy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purchase_order_guard_update() RETURNS trigger AS $$
BEGIN
  -- Identity is immutable at every status.
  IF NEW."id"          IS DISTINCT FROM OLD."id"
     OR NEW."poNumber"    IS DISTINCT FROM OLD."poNumber"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt"   IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'Purchase order % identity is immutable: its number and its creator never change.',
      OLD."poNumber";
  END IF;

  -- Commercial terms freeze the moment the PO leaves DRAFT.
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."supplierId"   IS DISTINCT FROM OLD."supplierId"
       OR NEW."orderDate"    IS DISTINCT FROM OLD."orderDate"
       OR NEW."expectedDate" IS DISTINCT FROM OLD."expectedDate"
       OR NEW."currency"     IS DISTINCT FROM OLD."currency"
       OR NEW."subtotal"     IS DISTINCT FROM OLD."subtotal"
    THEN
      RAISE EXCEPTION
        'Purchase order % is % and its commercial terms are frozen: supplier, dates, currency and value may only be edited while it is a DRAFT. The supplier holds a copy of an approved order.',
        OLD."poNumber", OLD."status";
    END IF;
  END IF;

  -- An approval, once recorded, is a historical fact.
  IF OLD."approvedById" IS NOT NULL THEN
    IF NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
    THEN
      RAISE EXCEPTION
        'Purchase order % was already approved; who approved it and when cannot be rewritten.',
        OLD."poNumber";
    END IF;
  END IF;

  -- The state machine.
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'DRAFT'
         AND NEW."status" IN ('APPROVED', 'CANCELLED'))
      OR
      (OLD."status" = 'APPROVED'
         AND NEW."status" IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'))
      OR
      (OLD."status" = 'PARTIALLY_RECEIVED'
         AND NEW."status" IN ('RECEIVED', 'CLOSED'))
      OR
      (OLD."status" = 'RECEIVED'
         AND NEW."status" = 'CLOSED')
    ) THEN
      RAISE EXCEPTION
        'Purchase order % may not move % -> %. Permitted: DRAFT->APPROVED|CANCELLED; APPROVED->PARTIALLY_RECEIVED|RECEIVED|CANCELLED; PARTIALLY_RECEIVED->RECEIVED|CLOSED; RECEIVED->CLOSED. CLOSED and CANCELLED are terminal, and a partially-received order is CLOSED short rather than cancelled, because goods have already arrived and been accrued.',
        OLD."poNumber", OLD."status", NEW."status";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER purchase_order_guard
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_order_guard_update();

-- ---------------------------------------------------------------------------
-- (j) THE LINE SET IS FROZEN ONCE THE PO LEAVES DRAFT.
--
-- Freezing the header's subtotal (above) is worthless if the lines it sums can
-- still change: the two would simply disagree. So a line's commercial terms —
-- which product, how many, at what cost — are frozen in step with the header, and
-- receivedQty remains the one mutable field, because that is what receiving a
-- delivery legitimately changes.
--
-- The PO's status is read with a schema-safe dynamic lookup via TG_TABLE_SCHEMA
-- rather than a bare `purchase_orders`: the pg adapter does not set search_path,
-- so an unqualified cross-table reference in a trigger body would resolve against
-- public (the engineering ledger "Raw SQL and Tenant Schema Resolution").
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

  -- UPDATE. Identity never changes; commercial terms freeze with the header;
  -- receivedQty is the one field a delivery may move.
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
        'Purchase order % is % : line terms (product, quantity, cost) are frozen. Only the received quantity may change, and only by receiving a delivery.',
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER purchase_order_line_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_line_guard();

-- ---------------------------------------------------------------------------
-- (k) A GOODS RECEIPT IS A POSTED FACT: NO UPDATE, NO DELETE, EVER.
--
-- Template: etims_invoice_no_delete (0016) and the stock-movement immutability
-- trigger (0005). A GRN records that goods physically arrived, that stock rose,
-- and that a liability was accrued to 2050 GRNI. Editing it would leave the
-- movements and the journal entry it produced describing a receipt that no longer
-- claims to have happened; deleting it would orphan both.
--
-- REVERSAL IS DEFERRED, and this trigger is what makes the deferral safe rather
-- than a gap: because a GRN cannot be quietly undone, a mis-receipt MUST be
-- corrected by a compensating document in Task 5.2's supplier-credit path, which
-- leaves both the original and the correction visible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION goods_receipt_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Goods receipt GRN-% is immutable: it records that stock arrived and that value was accrued to GRNI. Correct a mis-receipt with a supplier credit (Task 5.2), never by editing the receipt.',
      OLD."grnNumber";
  END IF;
  RAISE EXCEPTION
    'Goods receipt GRN-% cannot be deleted: its stock movements and its journal entry would be orphaned, and the GRNI accrual would remain with nothing explaining it.',
    OLD."grnNumber";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goods_receipt_no_update
  BEFORE UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_immutable();

CREATE TRIGGER goods_receipt_no_delete
  BEFORE DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_immutable();

-- (l) A GRN number is a positive integer, like a PO number.
ALTER TABLE "goods_receipts" ADD CONSTRAINT goods_receipt_number_positive
  CHECK ("grnNumber" > 0);

-- ---------------------------------------------------------------------------
-- (m) THE PROCUREMENT LINKS ON A STOCK MOVEMENT COME AS A PAIR.
--
-- A movement produced by a goods receipt carries BOTH the GRN and the PO line it
-- fulfilled; a movement from anywhere else carries NEITHER. One without the other
-- would be a half-recorded provenance: a GRN movement with no line cannot be
-- matched to a bill, and a line reference with no GRN claims a receipt that has no
-- record. Task 5.2's three-way match (PO line / GRN / bill line) depends on the
-- pair being complete.
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_movements" ADD CONSTRAINT stock_movement_procurement_links_paired
  CHECK (("goodsReceiptId" IS NULL) = ("purchaseOrderLineId" IS NULL));

-- ---------------------------------------------------------------------------
-- (n) DELIBERATELY NO CONSTRAINT tying PurchaseOrder.subtotal to SUM(lines.lineNet),
-- and none tying PurchaseOrder.status to the lines' received quantities.
--
-- Both are cross-row aggregates. A trigger enforcing either would have to
-- re-aggregate every line of the order on each line write, which is the same
-- considered trade-off recorded for the stock aggregate invariant in 0011: the
-- database enforces what is cheap and local (the per-row CHECKs above, the
-- over-receipt cap, the state machine, the frozen line set), one service writes
-- both sides inside one transaction, and the aggregate agreement is an acceptance
-- criterion. Recorded here so it is not mistaken for an oversight.
-- ---------------------------------------------------------------------------
