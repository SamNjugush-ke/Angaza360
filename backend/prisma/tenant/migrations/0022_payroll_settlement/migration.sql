-- AlterEnum
ALTER TYPE "PayrollRunStatus" ADD VALUE 'PAID' BEFORE 'CANCELLED';

-- CreateEnum
CREATE TYPE "PayrollSettlementMethod" AS ENUM ('CASH', 'BANK', 'MPESA');

-- CreateEnum
CREATE TYPE "StatutoryType" AS ENUM ('PAYE', 'NSSF', 'SHIF', 'HOUSING_LEVY');

-- CreateTable
CREATE TABLE "net_pay_payments" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "paymentDate" DATE NOT NULL,
    "method" "PayrollSettlementMethod" NOT NULL,
    "totalNet" BIGINT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "net_pay_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "net_pay_payment_lines" (
    "id" TEXT NOT NULL,
    "netPayPaymentId" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "method" "EmployeePaymentMethod" NOT NULL,
    "bankName" TEXT,
    "bankAccount" TEXT,

    CONSTRAINT "net_pay_payment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statutory_remittances" (
    "id" TEXT NOT NULL,
    "statutoryType" "StatutoryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "remittanceDate" DATE NOT NULL,
    "method" "PayrollSettlementMethod" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "payrollRunId" TEXT,
    "journalEntryId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statutory_remittances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "net_pay_payments_payrollRunId_key" ON "net_pay_payments"("payrollRunId");

-- CreateIndex
CREATE UNIQUE INDEX "net_pay_payments_journalEntryId_key" ON "net_pay_payments"("journalEntryId");

-- CreateIndex
CREATE INDEX "net_pay_payments_paymentDate_idx" ON "net_pay_payments"("paymentDate");

-- CreateIndex
CREATE UNIQUE INDEX "net_pay_payment_lines_payslipId_key" ON "net_pay_payment_lines"("payslipId");

-- CreateIndex
CREATE INDEX "net_pay_payment_lines_netPayPaymentId_idx" ON "net_pay_payment_lines"("netPayPaymentId");

-- CreateIndex
CREATE INDEX "net_pay_payment_lines_employeeId_idx" ON "net_pay_payment_lines"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "statutory_remittances_journalEntryId_key" ON "statutory_remittances"("journalEntryId");

-- CreateIndex
CREATE INDEX "statutory_remittances_statutoryType_idx" ON "statutory_remittances"("statutoryType");

-- CreateIndex
CREATE INDEX "statutory_remittances_payrollRunId_idx" ON "statutory_remittances"("payrollRunId");

-- CreateIndex
CREATE INDEX "statutory_remittances_remittanceDate_idx" ON "statutory_remittances"("remittanceDate");

-- AddForeignKey
ALTER TABLE "net_pay_payments" ADD CONSTRAINT "net_pay_payments_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "net_pay_payment_lines" ADD CONSTRAINT "net_pay_payment_lines_netPayPaymentId_fkey" FOREIGN KEY ("netPayPaymentId") REFERENCES "net_pay_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "net_pay_payment_lines" ADD CONSTRAINT "net_pay_payment_lines_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payslips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "net_pay_payment_lines" ADD CONSTRAINT "net_pay_payment_lines_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statutory_remittances" ADD CONSTRAINT "statutory_remittances_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- NOTHING TO BACKFILL. Every table here is new, and the only change to an existing
-- object is ONE ADDITIVE ENUM VALUE plus the replacement of three 0021 guard
-- definitions to admit it. No row of `payroll_runs`, `payslips` or any journal table
-- is touched: every run that was POSTED before this migration is still POSTED after
-- it, its accrual unchanged, and simply becomes settleable.
--
-- `ALTER TYPE ... ADD VALUE` runs inside the migration runner's per-tenant
-- transaction (legal since PostgreSQL 12), but the NEW VALUE CANNOT BE USED as an
-- enum literal until that transaction commits. So nothing below compares a column to
-- 'PAID' typed as "PayrollRunStatus": the CHECK compares `"status"::text`, and the
-- plpgsql bodies are only evaluated at run time, long after the commit.
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
-- (a) THE RUN'S RESTING STATE, re-declared to know about PAID.
--
-- 0021's `payroll_run_status_fields_coherent` was a CASE with no ELSE. A CASE that
-- matches no branch yields NULL, and a CHECK PASSES on NULL — so leaving it in place
-- would have let a PAID row carry anything at all, including no accrual entry. It is
-- replaced, not edited (0021 is recorded in both tenants' ledgers), and the new one
-- FAILS CLOSED: an unrecognised status is refused rather than waved through.
--
-- PAID carries exactly what POSTED carries — the accrual entry, its approver, its
-- posting time — because a paid run is a posted run whose net has also been settled.
-- ---------------------------------------------------------------------------
ALTER TABLE "payroll_runs" DROP CONSTRAINT payroll_run_status_fields_coherent;

ALTER TABLE "payroll_runs" ADD CONSTRAINT payroll_run_status_fields_coherent
  CHECK (
    CASE "status"::text
      WHEN 'DRAFT'     THEN "approvedById" IS NULL AND "postedAt" IS NULL AND "journalEntryId" IS NULL
      WHEN 'APPROVED'  THEN "approvedById" IS NOT NULL AND "postedAt" IS NULL AND "journalEntryId" IS NULL
      WHEN 'POSTED'    THEN "approvedById" IS NOT NULL AND "postedAt" IS NOT NULL AND "journalEntryId" IS NOT NULL
      WHEN 'PAID'      THEN "approvedById" IS NOT NULL AND "postedAt" IS NOT NULL AND "journalEntryId" IS NOT NULL
      WHEN 'CANCELLED' THEN "postedAt" IS NULL AND "journalEntryId" IS NULL
      ELSE false
    END
  );

-- ---------------------------------------------------------------------------
-- (b) THE RUN STATE MACHINE, extended by exactly one edge.
--
-- DRAFT     -> APPROVED | CANCELLED
-- APPROVED  -> POSTED | CANCELLED
-- POSTED    -> PAID                    (new: net pay settled)
-- PAID      -> terminal
-- CANCELLED -> terminal
--
-- Everything 0021 froze stays frozen; the body is 0021's with the POSTED branch added
-- and PAID made terminal. CREATE OR REPLACE keeps the existing trigger binding.
--
-- **POSTED -> PAID REQUIRES ITS SETTLEMENT ROW.** The flip is refused unless a
-- `net_pay_payments` row for the run already exists in this transaction, and that row
-- can only be inserted against a POSTED run (section (e)). Together: a run reads PAID
-- if and only if its net has been settled, and a settlement can only ever exist
-- against a run that had an accrual to settle. Neither half can be skipped by raw SQL.
--
-- CANCELLED stays unreachable from POSTED and from PAID. A booked accrual is corrected
-- by a reversing entry, never by declaring that the payroll did not happen — and once
-- the net is PAID, money has left the business, which no status can undo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payroll_run_guard() RETURNS trigger AS $$
DECLARE
  v_settlements integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION
        'Payroll run for %-% must be created as a DRAFT (got %). Posting is a separate operation because it is what books the accrual.',
        NEW."periodYear", NEW."periodMonth", NEW."status";
    END IF;
    RETURN NEW;
  END IF;

  -- Identity and period are frozen forever: a run IS a month's payroll, and
  -- re-pointing it at another month would move an accrual between periods.
  IF NEW."id"            IS DISTINCT FROM OLD."id"
     OR NEW."runNumber"   IS DISTINCT FROM OLD."runNumber"
     OR NEW."periodYear"  IS DISTINCT FROM OLD."periodYear"
     OR NEW."periodMonth" IS DISTINCT FROM OLD."periodMonth"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt"   IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'Payroll run % : its identity (number, period, who created it, when) can never be changed.',
      OLD."runNumber";
  END IF;

  -- The ruleset and the pay date freeze the moment the run leaves DRAFT, because
  -- from then on the payslips were computed from them.
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."statutoryScheduleId" IS DISTINCT FROM OLD."statutoryScheduleId"
       OR NEW."payDate" IS DISTINCT FROM OLD."payDate"
    THEN
      RAISE EXCEPTION
        'Payroll run % is % : the statutory schedule it used and its pay date are frozen. Its payslips were computed from them.',
        OLD."runNumber", OLD."status";
    END IF;
  END IF;

  -- The journal entry is write-once.
  IF OLD."journalEntryId" IS NOT NULL
     AND NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" THEN
    RAISE EXCEPTION
      'Payroll run % already has accrual entry %; a posted entry is immutable and is corrected by a reversal, never by re-pointing the run.',
      OLD."runNumber", OLD."journalEntryId";
  END IF;

  -- Once posted, who approved it and when it was posted are part of the record.
  IF OLD."status"::text IN ('POSTED', 'PAID')
     AND (NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
          OR NEW."postedAt" IS DISTINCT FROM OLD."postedAt")
  THEN
    RAISE EXCEPTION
      'Payroll run % is % : its approver and posting time are part of the posted record and cannot change.',
      OLD."runNumber", OLD."status";
  END IF;

  -- THE STATE MACHINE.
  IF NEW."status" <> OLD."status" THEN
    IF OLD."status"::text = 'DRAFT' THEN
      IF NEW."status"::text NOT IN ('APPROVED', 'CANCELLED') THEN
        RAISE EXCEPTION
          'Payroll run % : a DRAFT may only be APPROVED or CANCELLED (got %). It cannot be posted without being approved first.',
          OLD."runNumber", NEW."status";
      END IF;
    ELSIF OLD."status"::text = 'APPROVED' THEN
      IF NEW."status"::text NOT IN ('POSTED', 'CANCELLED') THEN
        RAISE EXCEPTION
          'Payroll run % : an APPROVED run may only be POSTED or CANCELLED (got %).',
          OLD."runNumber", NEW."status";
      END IF;
      IF NEW."status"::text = 'POSTED' AND NEW."journalEntryId" IS NULL THEN
        RAISE EXCEPTION
          'Payroll run % cannot be POSTED without its accrual journal entry.',
          OLD."runNumber";
      END IF;
    ELSIF OLD."status"::text = 'POSTED' THEN
      IF NEW."status"::text <> 'PAID' THEN
        RAISE EXCEPTION
          'Payroll run % is POSTED : its only onward transition is PAID (attempted %). A booked accrual is corrected by a reversing entry, never by cancelling the run.',
          OLD."runNumber", NEW."status";
      END IF;
      EXECUTE format('SELECT count(*) FROM %I.net_pay_payments WHERE "payrollRunId" = $1',
                     TG_TABLE_SCHEMA)
        INTO v_settlements USING OLD."id";
      IF v_settlements <> 1 THEN
        RAISE EXCEPTION
          'Payroll run % cannot become PAID without its net-pay settlement: a run that reads PAID with no settlement would claim money left the business that never did.',
          OLD."runNumber";
      END IF;
    ELSE
      RAISE EXCEPTION
        'Payroll run % is % , which is terminal. No further transition is possible (attempted %).',
        OLD."runNumber", OLD."status", NEW."status";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A POSTED or PAID run cannot be deleted. A PAID one carries both its accrual and a
-- settlement that records money leaving; deleting it would orphan both. A DRAFT or a
-- CANCELLED run has posted nothing and may still be discarded.
CREATE OR REPLACE FUNCTION payroll_run_no_delete_once_posted() RETURNS trigger AS $$
BEGIN
  IF OLD."status"::text IN ('POSTED', 'PAID') THEN
    RAISE EXCEPTION
      'Payroll run % is % and cannot be deleted: its accrual entry (and, once PAID, its net-pay settlement) would be orphaned, leaving the salary expense, the statutory liabilities and net salaries payable unexplained.',
      OLD."runNumber", OLD."status";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- (c) SETTLEMENT FIELD CONSTRAINTS.
-- ---------------------------------------------------------------------------
ALTER TABLE "net_pay_payments" ADD CONSTRAINT net_pay_payment_total_non_negative
  CHECK ("totalNet" >= 0);

-- A positive settlement has its entry; a zero one cannot (a zero-line entry is not a
-- journal entry). Pinned both ways so neither half can be forgotten.
ALTER TABLE "net_pay_payments" ADD CONSTRAINT net_pay_payment_entry_iff_positive
  CHECK (("totalNet" > 0) = ("journalEntryId" IS NOT NULL));

ALTER TABLE "net_pay_payment_lines" ADD CONSTRAINT net_pay_payment_line_amount_non_negative
  CHECK ("amount" >= 0);

-- You cannot remit nothing.
ALTER TABLE "statutory_remittances" ADD CONSTRAINT statutory_remittance_amount_positive
  CHECK ("amount" > 0);

-- The settlement entries are REAL foreign keys, not loose ids. Journal entries are
-- immutable and never deleted, so the audit link from a settlement to its posting can
-- never dangle.
ALTER TABLE "net_pay_payments" ADD CONSTRAINT net_pay_payments_journalEntryId_fkey
  FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;

ALTER TABLE "statutory_remittances" ADD CONSTRAINT statutory_remittances_journalEntryId_fkey
  FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- (d) A SETTLEMENT IS IMMUTABLE — no UPDATE, no DELETE, ever.
--
-- Same discipline as `supplier_payments` (0018) and `customer_receipts` (0020): each
-- row records that money LEFT, and has a journal entry behind it. The trigger is what
-- makes the deferred correction path (an authority's refund, a recovered overpayment)
-- SAFE rather than a gap: nobody can quietly delete the problem instead of
-- documenting it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payroll_settlement_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Payroll settlement record %.% is immutable: it records that money left the business and has a journal entry behind it. A correction is a new document, never an edit.',
      TG_TABLE_NAME, OLD."id";
  END IF;
  RAISE EXCEPTION
    'Payroll settlement record %.% cannot be deleted: its journal entry would be orphaned and the liability it settled would silently read as owed again.',
    TG_TABLE_NAME, OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER net_pay_payment_no_update_delete
  BEFORE UPDATE OR DELETE ON net_pay_payments
  FOR EACH ROW EXECUTE FUNCTION payroll_settlement_immutable();

CREATE TRIGGER net_pay_payment_line_no_update_delete
  BEFORE UPDATE OR DELETE ON net_pay_payment_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_settlement_immutable();

CREATE TRIGGER statutory_remittance_no_update_delete
  BEFORE UPDATE OR DELETE ON statutory_remittances
  FOR EACH ROW EXECUTE FUNCTION payroll_settlement_immutable();

-- ---------------------------------------------------------------------------
-- (e) A NET SETTLEMENT MAY ONLY BE WRITTEN AGAINST A POSTED RUN, AND EACH LINE IS
-- EXACTLY ONE OF THAT RUN'S PAYSLIPS.
--
-- Immediate (BEFORE INSERT) checks — every one of them is answerable from rows that
-- already exist when the row arrives, so there is no reason to wait for COMMIT:
--   * the run is POSTED — a DRAFT/APPROVED run has accrued nothing to settle, a PAID
--     run has been settled already, a CANCELLED one never happened;
--   * a line's payslip belongs to the settlement's run;
--   * a line's employee IS that payslip's employee;
--   * a line's amount IS that payslip's `netPay` — no partial, no rounding, no more.
-- (One line per payslip is the unique index on `payslipId`.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION net_pay_payment_insert_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_run    integer;
BEGIN
  EXECUTE format('SELECT "status"::text, "runNumber" FROM %I.payroll_runs WHERE "id" = $1',
                 TG_TABLE_SCHEMA)
    INTO v_status, v_run USING NEW."payrollRunId";

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Net-pay settlement references payroll run %, which does not exist.', NEW."payrollRunId";
  END IF;
  IF v_status <> 'POSTED' THEN
    RAISE EXCEPTION
      'Payroll run % is % : only a POSTED run can have its net pay settled. Before posting there is no accrual to settle; after PAID it has been settled already.',
      v_run, v_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER net_pay_payment_insert_guard_i
  BEFORE INSERT ON net_pay_payments
  FOR EACH ROW EXECUTE FUNCTION net_pay_payment_insert_guard();

CREATE OR REPLACE FUNCTION net_pay_payment_line_insert_guard() RETURNS trigger AS $$
DECLARE
  v_schema       text := TG_TABLE_SCHEMA;
  v_payment_run  text;
  v_slip_run     text;
  v_slip_emp     text;
  v_slip_net     bigint;
BEGIN
  EXECUTE format('SELECT "payrollRunId" FROM %I.net_pay_payments WHERE "id" = $1', v_schema)
    INTO v_payment_run USING NEW."netPayPaymentId";
  IF v_payment_run IS NULL THEN
    RAISE EXCEPTION 'Net-pay line references settlement %, which does not exist.', NEW."netPayPaymentId";
  END IF;

  EXECUTE format('SELECT "payrollRunId", "employeeId", "netPay" FROM %I.payslips WHERE "id" = $1', v_schema)
    INTO v_slip_run, v_slip_emp, v_slip_net USING NEW."payslipId";
  IF v_slip_run IS NULL THEN
    RAISE EXCEPTION 'Net-pay line references payslip %, which does not exist.', NEW."payslipId";
  END IF;

  IF v_slip_run <> v_payment_run THEN
    RAISE EXCEPTION
      'Payslip % belongs to a different payroll run than settlement %: a settlement pays exactly its own run''s payslips.',
      NEW."payslipId", NEW."netPayPaymentId";
  END IF;
  IF v_slip_emp <> NEW."employeeId" THEN
    RAISE EXCEPTION
      'Net-pay line names employee % but payslip % belongs to employee %: the audit line must say who was actually paid.',
      NEW."employeeId", NEW."payslipId", v_slip_emp;
  END IF;
  IF v_slip_net <> NEW."amount" THEN
    RAISE EXCEPTION
      'Net-pay line for payslip % is % cents but the payslip''s net pay is % cents. A settlement pays each payslip''s net exactly — never part of it, never more.',
      NEW."payslipId", NEW."amount", v_slip_net;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER net_pay_payment_line_insert_guard_i
  BEFORE INSERT ON net_pay_payment_lines
  FOR EACH ROW EXECUTE FUNCTION net_pay_payment_line_insert_guard();

-- ---------------------------------------------------------------------------
-- (f) DEFERRED CONSTRAINT: A NET SETTLEMENT IS COMPLETE AND AGREES WITH ITS RUN.
--
-- At COMMIT, for the settlement:
--   * `Σ lines.amount == totalNet`                — the header cannot drift from its lines;
--   * `count(lines) == count(run's payslips)`     — EVERY employee is accounted for,
--     including one whose net is zero (with each line pinned to its payslip's net by
--     (e), the count is what stops a line from being silently left out);
--   * `totalNet == Σ run's payslips.netPay`       — it settles exactly the accrual;
--   * the run IS PAID                              — a settlement row with its run left
--     POSTED would say the money left while the run still claims it is owed;
--   * the journal entry, when present, DEBITS 2120 BY EXACTLY `totalNet` — the
--     record of the settlement and the posting of it cannot disagree.
--
-- **THE 0019 LESSON, APPLIED UP FRONT.** Bound to BOTH tables whose rows can falsify
-- it, with the subject resolved from TG_TABLE_NAME: a binding on the lines alone
-- cannot fire for a settlement inserted with NO lines, which is precisely the
-- settlement that would be most wrong.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_net_pay_payment_complete() RETURNS trigger AS $$
DECLARE
  v_schema      text := TG_TABLE_SCHEMA;
  v_payment_id  text;
  v_run_id      text;
  v_total       bigint;
  v_entry       text;
  v_run_number  integer;
  v_run_status  text;
  v_line_sum    bigint;
  v_line_count  integer;
  v_slip_sum    bigint;
  v_slip_count  integer;
  v_entry_2120  bigint;
BEGIN
  IF TG_TABLE_NAME = 'net_pay_payments' THEN
    v_payment_id := NEW."id";
  ELSE
    v_payment_id := NEW."netPayPaymentId";
  END IF;

  EXECUTE format('SELECT "payrollRunId", "totalNet", "journalEntryId" FROM %I.net_pay_payments WHERE "id" = $1', v_schema)
    INTO v_run_id, v_total, v_entry USING v_payment_id;
  IF v_run_id IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT "runNumber", "status"::text FROM %I.payroll_runs WHERE "id" = $1', v_schema)
    INTO v_run_number, v_run_status USING v_run_id;

  EXECUTE format('SELECT COALESCE(SUM("amount"), 0), count(*) FROM %I.net_pay_payment_lines WHERE "netPayPaymentId" = $1', v_schema)
    INTO v_line_sum, v_line_count USING v_payment_id;

  EXECUTE format('SELECT COALESCE(SUM("netPay"), 0), count(*) FROM %I.payslips WHERE "payrollRunId" = $1', v_schema)
    INTO v_slip_sum, v_slip_count USING v_run_id;

  IF v_line_sum <> v_total THEN
    RAISE EXCEPTION
      'Net-pay settlement for payroll run % totals % cents but its lines sum to % cents. The header and its lines must agree to the cent.',
      v_run_number, v_total, v_line_sum;
  END IF;
  IF v_line_count <> v_slip_count THEN
    RAISE EXCEPTION
      'Net-pay settlement for payroll run % has % line(s) but the run has % payslip(s). Every employee on the run must be accounted for in its settlement.',
      v_run_number, v_line_count, v_slip_count;
  END IF;
  IF v_total <> v_slip_sum THEN
    RAISE EXCEPTION
      'Net-pay settlement for payroll run % is % cents but the run accrued % cents of net pay. A settlement pays exactly what was accrued.',
      v_run_number, v_total, v_slip_sum;
  END IF;
  IF v_run_status <> 'PAID' THEN
    RAISE EXCEPTION
      'Net-pay settlement for payroll run % was written but the run is still % : the settlement and the run''s PAID status commit together or not at all.',
      v_run_number, v_run_status;
  END IF;

  IF v_entry IS NOT NULL THEN
    EXECUTE format(
      'SELECT COALESCE(SUM(l."debit"), 0) - COALESCE(SUM(l."credit"), 0)
         FROM %I.journal_lines l JOIN %I.accounts a ON a."id" = l."accountId"
        WHERE l."entryId" = $1 AND a."code" = ''2120''', v_schema, v_schema)
      INTO v_entry_2120 USING v_entry;
    IF v_entry_2120 <> v_total THEN
      RAISE EXCEPTION
        'Net-pay settlement for payroll run % is % cents but its journal entry debits 2120 Net Salaries Payable by % cents. The settlement and its posting must agree.',
        v_run_number, v_total, v_entry_2120;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER net_pay_payment_complete_on_payment
  AFTER INSERT ON net_pay_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_net_pay_payment_complete();

CREATE CONSTRAINT TRIGGER net_pay_payment_complete_on_line
  AFTER INSERT ON net_pay_payment_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_net_pay_payment_complete();

-- ---------------------------------------------------------------------------
-- (g) DEFERRED CONSTRAINT: A REMITTANCE NEVER PAYS MORE THAN IS OWED.
--
-- At COMMIT, for the remittance:
--   * ITS HEAD IS NOT LEFT IN A DEBIT BALANCE — `credits − debits >= 0` over every
--     posted line on the head's liability account. You cannot remit more than you owe;
--     a debit balance on a statutory liability would be an unexplained receivable from
--     KRA, NSSF or SHA.
--   * WHEN TAGGED TO A RUN, the run is POSTED or PAID, and the remittances tagged to it
--     for this head do not exceed what that run's ACCRUAL credited to the head. A run
--     reading "over-remitted" would make the per-run tie-out meaningless.
--   * ITS JOURNAL ENTRY DEBITS THE HEAD BY EXACTLY `amount` — the record and the
--     posting cannot disagree, and a PAYE remittance cannot have been posted to NSSF.
--
-- Deferred because the remittance row and its entry arrive in separate statements,
-- and evaluated at COMMIT so the check sees the transaction's own posting.
--
-- WHY BOUND ONLY TO `statutory_remittances`, recorded so it is read as a decision.
-- Every input is either immutable once written (the run's accrual entry, earlier
-- remittances — so nothing but a NEW remittance can push a run over its accrual) or
-- the head's GL balance, which other journal lines can move. Binding the GL half to
-- `journal_lines` would evaluate it on every posting in the system — the hottest
-- write path there is — and would forbid an accountant's legitimate correcting entry
-- to a liability. So the GL-balance rule is an ACT-TIME guarantee about the
-- REMITTANCE ("this remittance did not overpay"), not a standing invariant on the
-- account; the per-run rule has no other falsifying table and is complete as bound.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_statutory_remittance_within_owed() RETURNS trigger AS $$
DECLARE
  v_schema       text := TG_TABLE_SCHEMA;
  v_account      text;
  v_balance      bigint;
  v_entry_debit  bigint;
  v_run_status   text;
  v_run_number   integer;
  v_run_entry    text;
  v_accrued      bigint;
  v_remitted     bigint;
BEGIN
  v_account := CASE NEW."statutoryType"::text
                 WHEN 'PAYE'         THEN '2200'
                 WHEN 'NSSF'         THEN '2210'
                 WHEN 'SHIF'         THEN '2220'
                 WHEN 'HOUSING_LEVY' THEN '2230'
               END;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Statutory remittance % has an unrecognised head %.', NEW."id", NEW."statutoryType";
  END IF;

  EXECUTE format(
    'SELECT COALESCE(SUM(l."debit"), 0) - COALESCE(SUM(l."credit"), 0)
       FROM %I.journal_lines l JOIN %I.accounts a ON a."id" = l."accountId"
      WHERE l."entryId" = $1 AND a."code" = $2', v_schema, v_schema)
    INTO v_entry_debit USING NEW."journalEntryId", v_account;
  IF v_entry_debit <> NEW."amount" THEN
    RAISE EXCEPTION
      'Statutory remittance % (%) is % cents but its journal entry debits account % by % cents. The remittance and its posting must agree.',
      NEW."id", NEW."statutoryType", NEW."amount", v_account, v_entry_debit;
  END IF;

  EXECUTE format(
    'SELECT COALESCE(SUM(l."credit"), 0) - COALESCE(SUM(l."debit"), 0)
       FROM %I.journal_lines l JOIN %I.accounts a ON a."id" = l."accountId"
      WHERE a."code" = $1', v_schema, v_schema)
    INTO v_balance USING v_account;
  IF v_balance < 0 THEN
    RAISE EXCEPTION
      'Statutory remittance % (%) of % cents would leave account % in a DEBIT balance of % cents. You cannot remit more than the business owes.',
      NEW."id", NEW."statutoryType", NEW."amount", v_account, -v_balance;
  END IF;

  IF NEW."payrollRunId" IS NOT NULL THEN
    EXECUTE format('SELECT "status"::text, "runNumber", "journalEntryId" FROM %I.payroll_runs WHERE "id" = $1', v_schema)
      INTO v_run_status, v_run_number, v_run_entry USING NEW."payrollRunId";
    IF v_run_status IS NULL OR v_run_status NOT IN ('POSTED', 'PAID') THEN
      RAISE EXCEPTION
        'Statutory remittance % is tagged to payroll run % which is % : only a POSTED or PAID run has accrued anything to remit.',
        NEW."id", COALESCE(v_run_number::text, NEW."payrollRunId"), COALESCE(v_run_status, 'missing');
    END IF;

    EXECUTE format(
      'SELECT COALESCE(SUM(l."credit"), 0) - COALESCE(SUM(l."debit"), 0)
         FROM %I.journal_lines l JOIN %I.accounts a ON a."id" = l."accountId"
        WHERE l."entryId" = $1 AND a."code" = $2', v_schema, v_schema)
      INTO v_accrued USING v_run_entry, v_account;

    EXECUTE format(
      'SELECT COALESCE(SUM("amount"), 0) FROM %I.statutory_remittances
        WHERE "payrollRunId" = $1 AND "statutoryType" = $2', v_schema)
      INTO v_remitted USING NEW."payrollRunId", NEW."statutoryType";

    IF v_remitted > v_accrued THEN
      RAISE EXCEPTION
        'Remittances of % tagged to payroll run % total % cents but the run accrued only % cents for that head. A run cannot be remitted beyond its own accrual.',
        NEW."statutoryType", v_run_number, v_remitted, v_accrued;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER statutory_remittance_within_owed_check
  AFTER INSERT ON statutory_remittances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_statutory_remittance_within_owed();
