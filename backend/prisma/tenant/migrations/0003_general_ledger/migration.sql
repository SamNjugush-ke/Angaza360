-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalEntryStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "JournalSource" AS ENUM ('MANUAL', 'POS', 'SALE_RETURN', 'PURCHASE', 'PAYROLL', 'EXPENSE', 'INVENTORY_ADJUSTMENT', 'BANK_RECONCILIATION', 'OPENING_BALANCE', 'DEPRECIATION');

-- CreateTable
CREATE TABLE "accounting_periods" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "entryNumber" TEXT NOT NULL,
    "entryDate" DATE NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "source" "JournalSource" NOT NULL,
    "sourceId" TEXT,
    "status" "JournalEntryStatus" NOT NULL DEFAULT 'POSTED',
    "reversesEntryId" TEXT,
    "reversedByEntryId" TEXT,
    "createdBy" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" BIGINT NOT NULL DEFAULT 0,
    "credit" BIGINT NOT NULL DEFAULT 0,
    "memo" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_periods_status_idx" ON "accounting_periods"("status");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_year_month_key" ON "accounting_periods"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_entryNumber_key" ON "journal_entries"("entryNumber");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversesEntryId_key" ON "journal_entries"("reversesEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversedByEntryId_key" ON "journal_entries"("reversedByEntryId");

-- CreateIndex
CREATE INDEX "journal_entries_entryDate_idx" ON "journal_entries"("entryDate");

-- CreateIndex
CREATE INDEX "journal_entries_periodYear_periodMonth_idx" ON "journal_entries"("periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "journal_entries_source_sourceId_idx" ON "journal_entries"("source", "sourceId");

-- CreateIndex
CREATE INDEX "journal_lines_accountId_idx" ON "journal_lines"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_entryId_lineNumber_key" ON "journal_lines"("entryId", "lineNumber");

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. Prisma cannot express any of it, and
-- it is the part that makes the engineering ledger's guarantees real: the database makes the
-- invalid states unrepresentable, so a future module with a bug in its
-- application logic still cannot corrupt the books.
--
-- All identifiers are unqualified and resolve against the tenant's search_path
-- at runtime — the migration is schema-neutral: it never creates a schema and
-- never hard-codes a schema-qualified prefix.
-- ===========================================================================

-- (a) Per-tenant entry-number sequence. Lives in the tenant schema; each tenant
-- numbers its own entries independently.
CREATE SEQUENCE journal_entry_seq START 1;

-- (b) Line sanity: non-negative, and exactly one side populated. A both-zero
-- line is meaningless; a both-populated line is ambiguous. Reject both.
ALTER TABLE "journal_lines" ADD CONSTRAINT journal_line_single_sided
  CHECK (
    debit >= 0 AND credit >= 0
    AND ( (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0) )
  );

-- (c) THE BALANCE CONSTRAINT. A DEFERRABLE INITIALLY DEFERRED constraint trigger
-- that re-aggregates the parent entry and refuses to commit unless the entry has
-- at least two lines and SUM(debit) = SUM(credit). Because it is deferred, a
-- multi-statement insert of a balanced entry succeeds (the lines are all present
-- by COMMIT), while any transaction that would leave an unbalanced entry fails
-- atomically at COMMIT. This is enforcement, not ergonomics — never weaken it.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
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

  -- If the parent entry is gone there is nothing to validate.
  SELECT "entryNumber" INTO v_entry_number FROM journal_entries WHERE id = v_entry_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*), COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO v_line_count, v_debit, v_credit
    FROM journal_lines WHERE "entryId" = v_entry_id;

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

CREATE CONSTRAINT TRIGGER journal_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- (d) Immutability. A posted entry is append-only. The ONLY permitted mutation
-- of journal_entries is marking it reversed (reversedByEntryId NULL -> value,
-- status POSTED -> REVERSED). Lines are write-once: never updated, never deleted.
CREATE OR REPLACE FUNCTION journal_entry_guard_update() RETURNS trigger AS $$
BEGIN
  -- Any change to a column other than status/reversedByEntryId is forbidden.
  IF NEW.id                IS DISTINCT FROM OLD.id
     OR NEW."entryNumber"  IS DISTINCT FROM OLD."entryNumber"
     OR NEW."entryDate"    IS DISTINCT FROM OLD."entryDate"
     OR NEW."periodYear"   IS DISTINCT FROM OLD."periodYear"
     OR NEW."periodMonth"  IS DISTINCT FROM OLD."periodMonth"
     OR NEW.description    IS DISTINCT FROM OLD.description
     OR NEW.reference      IS DISTINCT FROM OLD.reference
     OR NEW.source         IS DISTINCT FROM OLD.source
     OR NEW."sourceId"     IS DISTINCT FROM OLD."sourceId"
     OR NEW."reversesEntryId" IS DISTINCT FROM OLD."reversesEntryId"
     OR NEW."createdBy"    IS DISTINCT FROM OLD."createdBy"
     OR NEW."postedAt"     IS DISTINCT FROM OLD."postedAt"
  THEN
    RAISE EXCEPTION 'Journal entry % is immutable; only reversal marking is permitted.',
      OLD."entryNumber";
  END IF;

  -- Validate the reversal transition itself.
  IF OLD."reversedByEntryId" IS NOT NULL THEN
    RAISE EXCEPTION 'Journal entry % is already reversed.', OLD."entryNumber";
  END IF;
  IF NEW."reversedByEntryId" IS NULL THEN
    RAISE EXCEPTION 'Journal entry % update did not set reversedByEntryId.', OLD."entryNumber";
  END IF;
  IF NOT (OLD.status::text = 'POSTED' AND NEW.status::text = 'REVERSED') THEN
    RAISE EXCEPTION 'Journal entry % reversal must transition status POSTED -> REVERSED.',
      OLD."entryNumber";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entry_no_update
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_guard_update();

CREATE OR REPLACE FUNCTION journal_entry_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Journal entries are immutable and cannot be deleted (entry %).',
    OLD."entryNumber";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entry_no_delete
  BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_no_delete();

CREATE OR REPLACE FUNCTION journal_line_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Journal lines are write-once and cannot be % once posted.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_line_no_change
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_line_no_change();

-- (e) Period lock. Refuse to insert an entry into a CLOSED period. A missing
-- period is permitted here — the posting service creates it as OPEN.
CREATE OR REPLACE FUNCTION journal_entry_period_lock() RETURNS trigger AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status::text INTO v_status FROM accounting_periods
    WHERE year = NEW."periodYear" AND month = NEW."periodMonth";
  IF FOUND AND v_status = 'CLOSED' THEN
    RAISE EXCEPTION 'Accounting period %-% is CLOSED; cannot post entry %.',
      NEW."periodYear", NEW."periodMonth", NEW."entryNumber";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entry_period_lock
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_period_lock();

-- (f) Chart-of-accounts protection. An account that already carries postings may
-- be renamed or deactivated, but never deleted, and its code/accountClass may
-- never be changed — re-classifying it would silently rewrite history.
CREATE OR REPLACE FUNCTION accounts_protect() RETURNS trigger AS $$
DECLARE
  v_refs bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT count(*) INTO v_refs FROM journal_lines WHERE "accountId" = OLD.id;
    IF v_refs > 0 THEN
      RAISE EXCEPTION 'Account % (%) has % posting(s) and cannot be deleted.',
        OLD.code, OLD.name, v_refs;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: block code / accountClass change when postings exist.
  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW."accountClass" IS DISTINCT FROM OLD."accountClass"
  THEN
    SELECT count(*) INTO v_refs FROM journal_lines WHERE "accountId" = OLD.id;
    IF v_refs > 0 THEN
      RAISE EXCEPTION 'Account % has % posting(s); code and accountClass cannot be changed.',
        OLD.code, v_refs;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_protect
  BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_protect();
