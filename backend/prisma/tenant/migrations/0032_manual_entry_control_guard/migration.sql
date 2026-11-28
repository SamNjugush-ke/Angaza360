-- ===========================================================================
-- 0032 — A MANUAL JOURNAL ENTRY MAY NOT TOUCH A SUBLEDGER CONTROL ACCOUNT
-- (Task T-B-JE-CONTROL-GUARD). HAND-WRITTEN.
--
-- 1015 M-Pesa Clearing, 1100 Accounts Receivable, 1200 Inventory, 2000 Accounts Payable and 2050
-- GRNI are each DEFINED by a subledger or a single writer (src/services/control-accounts.ts). A
-- hand-posted line on one has no document behind it and breaks its reconciliation on the spot —
-- the reason a stray manual entry to 1200 once had to be reversed. The ledger service refuses it
-- with a clean 400; THIS TRIGGER IS THE GUARANTEE, for every writer.
--
-- Scope: an entry whose `source` is MANUAL. Module postings carry their own source (POS, PURCHASE,
-- PAYROLL, …) and are untouched. A REVERSAL (reversesEntryId set) is exempt, so a stray historical
-- manual entry can still be undone by its reversal. Journal lines are immutable (0003), so the rule
-- needs only INSERT; no existing row is read or rewritten. The entry is read through
-- TG_TABLE_SCHEMA (schema-safe, the engineering ledger "Raw SQL").
-- ===========================================================================

CREATE OR REPLACE FUNCTION journal_line_manual_control_guard() RETURNS trigger AS $$
DECLARE
  entry_source TEXT;
  entry_reverses TEXT;
  account_code TEXT;
BEGIN
  EXECUTE format('SELECT "source"::text, "reversesEntryId" FROM %I.journal_entries WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO entry_source, entry_reverses USING NEW."entryId";
  IF entry_source IS DISTINCT FROM 'MANUAL' OR entry_reverses IS NOT NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT "code" FROM %I.accounts WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO account_code USING NEW."accountId";
  IF account_code IN ('1015', '1100', '1200', '2000', '2050') THEN
    RAISE EXCEPTION 'manual_entry_control_account: account % is a subledger control account and cannot take a MANUAL journal line', account_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_line_manual_control_guard
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION journal_line_manual_control_guard();
