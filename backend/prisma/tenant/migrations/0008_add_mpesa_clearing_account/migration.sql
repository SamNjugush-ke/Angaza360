-- ===========================================================================
-- HAND-WRITTEN DATA MIGRATION (Task 3.3). Adds account 1015 "M-Pesa Clearing
-- (STK Pending)" to existing tenant schemas. The accounts table has no
-- immutability trigger, so a plain idempotent INSERT is fine. New tenants get
-- 1015 automatically because it is now in DEFAULT_CHART_OF_ACCOUNTS.
--
-- Schema-neutral: runs under the tenant's search_path (set by the migration
-- runner), so table and enum names are unqualified. It neither creates a schema
-- nor hard-codes a schema-qualified prefix.
-- ===========================================================================

INSERT INTO "accounts"
  ("id", "code", "name", "accountClass", "normalBalance", "description",
   "isSystem", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), '1015', 'M-Pesa Clearing (STK Pending)',
   'ASSET'::"AccountClass", 'DEBIT'::"NormalBalance",
   'Holds M-Pesa STK Push amounts promised but not yet settled to the till. Debited for the M-Pesa portion of a tender at sale time; cleared to 1010 M-Pesa Till on a confirmed callback, or reversed on failure/timeout.',
   true, true, now(), now())
ON CONFLICT ("code") DO NOTHING;
