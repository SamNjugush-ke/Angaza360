-- ===========================================================================
-- HAND-WRITTEN — schema-safety hardening for the ledger triggers.
--
-- The pg adapter qualifies Prisma-generated SQL with the tenant schema but does
-- NOT set the connection search_path (it stays "$user", public). A plpgsql
-- trigger function resolves UNqualified table names against the search_path at
-- execution time, so the cross-table lookups added in 0003 could fail to find
-- the tenant's tables when a trigger fires under the default search_path.
--
-- This migration replaces the three cross-table trigger functions with versions
-- that qualify every table reference by TG_TABLE_SCHEMA — the schema of the
-- table the trigger is attached to. The guarantee now holds for ANY writer,
-- regardless of search_path, which is exactly what an integrity trigger must do.
-- The trigger objects themselves are unchanged (they bind by function name), so
-- only the function bodies are replaced. The immutability functions from 0003
-- touch only OLD/NEW and need no change.
-- ===========================================================================

-- Balance constraint (deferred): re-aggregate the parent entry, schema-safe.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  v_schema       text := TG_TABLE_SCHEMA;
  v_entry_id     text;
  v_entry_number text;
  v_line_count   integer;
  v_debit        bigint;
  v_credit       bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_entry_id := OLD."entryId";
  ELSE
    v_entry_id := NEW."entryId";
  END IF;

  EXECUTE format('SELECT "entryNumber" FROM %I.journal_entries WHERE id = $1', v_schema)
    INTO v_entry_number USING v_entry_id;

  -- Parent entry gone (impossible in normal operation): nothing to validate.
  IF v_entry_number IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format(
    'SELECT count(*), COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0) FROM %I.journal_lines WHERE "entryId" = $1',
    v_schema)
    INTO v_line_count, v_debit, v_credit USING v_entry_id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % must have at least two lines (found %).',
      v_entry_number, v_line_count;
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: debits % <> credits % (imbalance % cents).',
      v_entry_number, v_debit, v_credit, (v_debit - v_credit);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Period lock: refuse an insert into a CLOSED period, schema-safe.
CREATE OR REPLACE FUNCTION journal_entry_period_lock() RETURNS trigger AS $$
DECLARE
  v_schema text := TG_TABLE_SCHEMA;
  v_status text;
BEGIN
  EXECUTE format('SELECT status::text FROM %I.accounting_periods WHERE year = $1 AND month = $2', v_schema)
    INTO v_status USING NEW."periodYear", NEW."periodMonth";

  IF v_status = 'CLOSED' THEN
    RAISE EXCEPTION 'Accounting period %-% is CLOSED; cannot post entry %.',
      NEW."periodYear", NEW."periodMonth", NEW."entryNumber";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Chart-of-accounts protection: block delete / reclassification of an account
-- that already carries postings, schema-safe.
CREATE OR REPLACE FUNCTION accounts_protect() RETURNS trigger AS $$
DECLARE
  v_schema text := TG_TABLE_SCHEMA;
  v_refs   bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('SELECT count(*) FROM %I.journal_lines WHERE "accountId" = $1', v_schema)
      INTO v_refs USING OLD.id;
    IF v_refs > 0 THEN
      RAISE EXCEPTION 'Account % (%) has % posting(s) and cannot be deleted.',
        OLD.code, OLD.name, v_refs;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW."accountClass" IS DISTINCT FROM OLD."accountClass"
  THEN
    EXECUTE format('SELECT count(*) FROM %I.journal_lines WHERE "accountId" = $1', v_schema)
      INTO v_refs USING OLD.id;
    IF v_refs > 0 THEN
      RAISE EXCEPTION 'Account % has % posting(s); code and accountClass cannot be changed.',
        OLD.code, v_refs;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
