-- ===========================================================================
-- 0034 — M-PESA RECONCILIATION + INTEGRATION HEALTH (M4.5 Wave 1, T-B2 / T-B1). HAND-WRITTEN.
--
-- (a) mpesa_transactions gains the STK-QUERY bookkeeping: when Safaricom was last asked
--     what became of a push whose callback never came, how many times, and what it said.
--     The query is NOT a callback: it carries no M-Pesa receipt, so a "paid" answer
--     (queryResultCode = 0) leaves the row INITIATED — `mpesa_ok_requires_receipt` still
--     demands the receipt for CALLBACK_OK — and keeps it out of the timeout sweep, so a
--     paid push is never timed out. The existing guard (0009) already freezes every
--     terminal row; the query counter may only rise.
-- (b) tenant_integration_credentials gains a HEALTH record of the last live verify:
--     UNVERIFIED | HEALTHY | FAILING, when it was checked, and the last error IN WORDS (never
--     a secret — the service scrubs every stored field value out of it).
-- No existing row is rewritten: every new column defaults to "never queried / unverified".
-- ===========================================================================

-- (a) -----------------------------------------------------------------------------
ALTER TABLE "mpesa_transactions"
  ADD COLUMN "lastQueriedAt" TIMESTAMPTZ(3),
  ADD COLUMN "queryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "queryResultCode" INTEGER,
  ADD COLUMN "queryResultDesc" TEXT;

ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_query_bookkeeping_coherent" CHECK (
  ("queryCount" = 0 AND "lastQueriedAt" IS NULL AND "queryResultCode" IS NULL AND "queryResultDesc" IS NULL)
  OR ("queryCount" > 0 AND "lastQueriedAt" IS NOT NULL)
);

CREATE OR REPLACE FUNCTION mpesa_txn_query_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."queryCount" < OLD."queryCount" THEN
    RAISE EXCEPTION 'mpesa_txn_query_guard: M-Pesa transaction % — the STK query count can only rise.', OLD."checkoutRequestId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mpesa_txn_query_guard
  BEFORE UPDATE ON "mpesa_transactions"
  FOR EACH ROW EXECUTE FUNCTION mpesa_txn_query_guard();

-- (b) -----------------------------------------------------------------------------
ALTER TABLE "tenant_integration_credentials"
  ADD COLUMN "healthStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "lastHealthCheckAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastHealthError" TEXT;

-- Fail closed: a status nobody listed is refused (ELSE false — the 0022 law).
ALTER TABLE "tenant_integration_credentials" ADD CONSTRAINT "credential_health_coherent" CHECK (
  CASE "healthStatus"
    WHEN 'UNVERIFIED' THEN "lastHealthError" IS NULL
    WHEN 'HEALTHY' THEN "lastHealthCheckAt" IS NOT NULL AND "lastHealthError" IS NULL
    WHEN 'FAILING' THEN "lastHealthCheckAt" IS NOT NULL AND "lastHealthError" IS NOT NULL AND length("lastHealthError") <= 300
    ELSE false
  END
);
