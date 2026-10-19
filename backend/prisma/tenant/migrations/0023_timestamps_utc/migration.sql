-- ===========================================================================
-- 0023 — TIMESTAMP-BASIS HARDENING (Task H.1). HAND-WRITTEN; MUST NOT BE REGENERATED.
--
-- Two kinds of time, two storage types, and nothing in between:
--
--   * MACHINE TIMESTAMPS (createdAt, updatedAt, businessTimestamp, receivedAt, …)
--     become TIMESTAMPTZ — an unambiguous instant.
--   * BUSINESS DATES that were stored as naive timestamps (billDate, dueDate, the
--     supplier paymentDate, receiptDate, orderDate, expectedDate, originalBusinessDate)
--     become DATE, joining entryDate, payDate, remittanceDate and the rest. An
--     accounting date is a calendar day, not a moment, and storing it as one is what
--     let a report compare it with an instant.
--
-- WHY `USING … AT TIME ZONE 'UTC'` AND NOT PRISMA'S BARE `SET DATA TYPE`. A bare
-- timestamp -> timestamptz cast interprets each naive value in the SESSION's zone.
-- This server's default is Africa/Nairobi, so the bare cast would have shifted every
-- historical instant three hours into the past. The explicit clause DECLARES what is
-- true of the data: every Prisma-written value was written in UTC. (Rows written
-- through a DB-side `now()` before the pool was pinned to UTC hold Nairobi wall-clock
-- time and therefore read three hours late after this; they are non-financial
-- metadata — seeded `createdAt`s and raw `updatedAt = now()` touches — and are left as
-- they are, because no reliable marker distinguishes them and guessing would rewrite
-- correct rows. Recorded in the engineering ledger "Timestamps & reporting dates".)
--
-- WHY THE BUSINESS DATES ARE CHECKED BEFORE THEY ARE CONVERTED. timestamp -> date
-- discards the time of day. Every value in these columns is expected to be exactly
-- midnight (they are parsed from YYYY-MM-DD), so the conversion is lossless — and this
-- migration REFUSES rather than truncates if that is ever not so, because a business
-- date carrying a time would mean something wrote an instant where a date belonged,
-- which is a defect to investigate, not a fraction to drop.
--
-- WHAT DOES NOT MOVE. No amount, no entryDate, no journal row. Row triggers do not
-- fire on ALTER COLUMN TYPE, so the immutability guards on sales and supplier bills
-- are neither tripped nor bypassed: the stored instant/day is unchanged, only its type
-- became unambiguous. Every pre-existing DATE column is untouched.
-- ===========================================================================

DO $$
DECLARE
  v_bad bigint;
BEGIN
  SELECT
      (SELECT count(*) FROM "supplier_bills"    WHERE "billDate"     <> date_trunc('day', "billDate"))
    + (SELECT count(*) FROM "supplier_bills"    WHERE "dueDate"      <> date_trunc('day', "dueDate"))
    + (SELECT count(*) FROM "supplier_payments" WHERE "paymentDate"  <> date_trunc('day', "paymentDate"))
    + (SELECT count(*) FROM "customer_receipts" WHERE "receiptDate"  <> date_trunc('day', "receiptDate"))
    + (SELECT count(*) FROM "purchase_orders"   WHERE "orderDate"    <> date_trunc('day', "orderDate"))
    + (SELECT count(*) FROM "purchase_orders"   WHERE "expectedDate" <> date_trunc('day', "expectedDate"))
    + (SELECT count(*) FROM "sales"             WHERE "originalBusinessDate" <> date_trunc('day', "originalBusinessDate"))
    INTO v_bad;
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '0023: % business-date value(s) carry a time of day. Converting them to DATE would discard it. Investigate which writer stored an instant where a calendar date belongs before re-running.',
      v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (a) BUSINESS DATES -> DATE (lossless: verified midnight above).
-- ---------------------------------------------------------------------------
ALTER TABLE "supplier_bills"
  ALTER COLUMN "billDate" SET DATA TYPE DATE USING "billDate"::date,
  ALTER COLUMN "dueDate"  SET DATA TYPE DATE USING "dueDate"::date;

ALTER TABLE "supplier_payments"
  ALTER COLUMN "paymentDate" SET DATA TYPE DATE USING "paymentDate"::date;

ALTER TABLE "customer_receipts"
  ALTER COLUMN "receiptDate" SET DATA TYPE DATE USING "receiptDate"::date;

ALTER TABLE "purchase_orders"
  ALTER COLUMN "orderDate"    SET DATA TYPE DATE USING "orderDate"::date,
  ALTER COLUMN "expectedDate" SET DATA TYPE DATE USING "expectedDate"::date;

ALTER TABLE "sales"
  ALTER COLUMN "originalBusinessDate" SET DATA TYPE DATE USING "originalBusinessDate"::date;

-- ---------------------------------------------------------------------------
-- (b) MACHINE TIMESTAMPS -> TIMESTAMPTZ, each declared to have been UTC.
-- Column defaults (CURRENT_TIMESTAMP) are kept; under the UTC-pinned pool they now
-- write UTC, and as timestamptz they are unambiguous whatever the session zone.
-- ---------------------------------------------------------------------------
ALTER TABLE "accounting_periods"
  ALTER COLUMN "closedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "closedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "accounts"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "allocation_requests"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "decidedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "decidedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "business_profile"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "captured_sales"
  ALTER COLUMN "businessTimestamp" SET DATA TYPE TIMESTAMPTZ(3) USING "businessTimestamp" AT TIME ZONE 'UTC',
  ALTER COLUMN "receivedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "receivedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "resolvedAt" AT TIME ZONE 'UTC';

ALTER TABLE "customer_receipt_allocations"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "customer_receipts"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "customers"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "employees"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "etims_devices"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastInitAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastInitAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "etims_invoices"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastAttemptAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastAttemptAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "goods_receipts"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "receivedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "receivedAt" AT TIME ZONE 'UTC';

ALTER TABLE "integration_settings"
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "journal_entries"
  ALTER COLUMN "postedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "postedAt" AT TIME ZONE 'UTC';

ALTER TABLE "locations"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "mpesa_transactions"
  ALTER COLUMN "completedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "completedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "initiatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "initiatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "net_pay_payments"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "payroll_runs"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "postedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "postedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "payslips"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "pos_devices"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastSyncAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastSyncAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "leaseExpiresAt" SET DATA TYPE TIMESTAMPTZ(3) USING "leaseExpiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "leaseStartedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "leaseStartedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "product_location_stock"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "products"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "expiryDate" SET DATA TYPE TIMESTAMPTZ(3) USING "expiryDate" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "purchase_order_lines"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "purchase_orders"
  ALTER COLUMN "approvedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "approvedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "sale_tenders"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "sales"
  ALTER COLUMN "businessTimestamp" SET DATA TYPE TIMESTAMPTZ(3) USING "businessTimestamp" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "syncedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "syncedAt" AT TIME ZONE 'UTC';

ALTER TABLE "shifts"
  ALTER COLUMN "closedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "closedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "openedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "openedAt" AT TIME ZONE 'UTC';

ALTER TABLE "statutory_remittances"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "statutory_schedules"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "stock_freezes"
  ALTER COLUMN "frozenAt" SET DATA TYPE TIMESTAMPTZ(3) USING "frozenAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "leaseExpiredAt" SET DATA TYPE TIMESTAMPTZ(3) USING "leaseExpiredAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "resolvedAt" AT TIME ZONE 'UTC';

ALTER TABLE "stock_movements"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "supplier_bill_lines"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "supplier_bills"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "supplier_payment_allocations"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "supplier_payments"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "suppliers"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "tenant_integration_credentials"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastVerifiedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastVerifiedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

